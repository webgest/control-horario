'use strict';

// ── Cargar variables de entorno desde .env si existe ──────────────────────────
try {
  require('fs').readFileSync('.env', 'utf8')
    .split('\n')
    .filter(l => l && !l.startsWith('#'))
    .forEach(l => {
      const [k, ...v] = l.split('=');
      if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim();
    });
} catch (_) {}

process.env.TZ = process.env.TZ || 'Europe/Madrid';

const express  = require('express');
const bcrypt   = require('bcrypt');
const jwt      = require('jsonwebtoken');
const cron     = require('node-cron');
const PDFDoc   = require('pdfkit');
const path     = require('path');

const { db, queries, decimalToHHMM, calcularHoraFin, calcularHorasTrabajadas, horaDisplay } = require('./database');
const { smsFin } = require('./sms');

const app    = express();
const PORT   = parseInt(process.env.PORT || '3000');
const SECRET = process.env.JWT_SECRET || 'dev_secret_cambiar_en_produccion';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ─── MIDDLEWARE JWT ──────────────────────────────────────────────────────────────

function authWorker(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin autorización' });
  try {
    req.user = jwt.verify(token, SECRET);
    if (req.user.role !== 'worker') throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

function authAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin autorización' });
  try {
    req.user = jwt.verify(token, SECRET);
    if (req.user.role !== 'admin') throw new Error();
    next();
  } catch {
    res.status(401).json({ error: 'Token inválido o expirado' });
  }
}

// ─── HELPERS ────────────────────────────────────────────────────────────────────

// Hora actual en Europe/Madrid como string 'YYYY-MM-DD HH:MM:SS'
// Usa la API Intl con timezone explícito — no depende de process.env.TZ ni de SQLite localtime
function nowMadrid() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 19);
}

function todayMadrid() {
  return nowMadrid().slice(0, 10);
}

function horaDisplay(isoStr) {
  if (!isoStr) return '—';
  return isoStr.slice(11, 16);
}

// ─── RUTAS DE AUTENTICACIÓN ──────────────────────────────────────────────────────

// GET /api/trabajadoras-publico — lista pública de empresas y trabajadoras (sin datos sensibles)
app.get('/api/trabajadoras-publico', (req, res) => {
  const empresas = queries.getAllEmpresas.all();
  const result = empresas.map(emp => ({
    id: emp.id,
    nombre: emp.nombre,
    trabajadoras: db.prepare(`
      SELECT id, nombre, estado FROM trabajadoras
      WHERE empresa_id = ? AND activa = 1
      ORDER BY nombre
    `).all(emp.id),
  }));
  res.json(result);
});

// POST /api/auth/login — trabajadora sin contraseña (solo ID de trabajadora)
app.post('/api/auth/login', (req, res) => {
  const { trabajadora_id } = req.body || {};
  if (!trabajadora_id) return res.status(400).json({ error: 'Falta el identificador de trabajadora' });

  const worker = queries.getTrabajadoraById.get(parseInt(trabajadora_id));
  if (!worker || !worker.activa) return res.status(404).json({ error: 'Trabajadora no encontrada' });

  const token = jwt.sign(
    { id: worker.id, role: 'worker', nombre: worker.nombre, empresa: worker.empresa_nombre },
    SECRET,
    { expiresIn: '24h' }
  );

  res.json({
    token,
    nombre: worker.nombre,
    empresa: worker.empresa_nombre,
    estado: worker.estado,
    horas_dia: worker.horas_dia,
    tipo_jornada: worker.tipo_jornada,
  });
});

// POST /api/auth/admin/login — administrador Webgest
app.post('/api/auth/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contraseña requeridos' });

  const admin = queries.getAdminByUsername.get(username.trim());
  if (!admin) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const ok = await bcrypt.compare(password, admin.password);
  if (!ok) return res.status(401).json({ error: 'Credenciales incorrectas' });

  const token = jwt.sign(
    { id: admin.id, role: 'admin', username: admin.username, nombre: admin.nombre },
    SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, nombre: admin.nombre, username: admin.username });
});

// ─── RUTAS DE TRABAJADORA ────────────────────────────────────────────────────────

// GET /api/fichar/estado — estado actual del día
app.get('/api/fichar/estado', authWorker, (req, res) => {
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayMadrid());
  const worker = queries.getTrabajadoraById.get(req.user.id);

  if (!hoy) {
    return res.json({ estado: 'sin_fichar', fichaje: null, horas_dia: worker.horas_dia });
  }

  if (!hoy.hora_salida) {
    const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia);
    return res.json({
      estado: 'en_jornada',
      fichaje: hoy,
      hora_fin_prevista: fin.toISOString(),
      hora_fin_display: fin.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' }),
    });
  }

  return res.json({ estado: 'jornada_completada', fichaje: hoy });
});

// POST /api/fichar/entrada — fichar entrada
app.post('/api/fichar/entrada', authWorker, (req, res) => {
  const worker = queries.getTrabajadoraById.get(req.user.id);

  if (!worker) return res.status(404).json({ error: 'Trabajadora no encontrada' });

  // Bloquear si está en IT o baja
  if (worker.estado === 'IT' || worker.estado === 'baja') {
    return res.status(403).json({ error: `No puedes fichar: estás en situación de ${worker.estado}.` });
  }

  // Comprobar si ya fichó hoy
  const hoyStr = todayMadrid();
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, hoyStr);

  if (hoy && hoy.hora_salida) {
    return res.status(409).json({ error: 'Ya has completado tu jornada de hoy.' });
  }

  if (hoy && !hoy.hora_salida) {
    // Ya hay fichaje abierto
    const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia);
    const finDisplay = fin.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });
    return res.json({
      estado: 'en_jornada',
      fichaje: hoy,
      hora_fin_prevista: fin.toISOString(),
      hora_fin_display: finDisplay,
      mensaje: `Ya tienes la jornada iniciada. Finaliza hoy a las ${finDisplay}.`,
    });
  }

  // Crear nuevo fichaje — hora tomada en JavaScript con timezone explícito Europe/Madrid
  const ahora = nowMadrid();
  const result = queries.createFichaje.run(req.user.id, hoyStr, ahora);
  const fichaje = queries.getFichajeById.get(result.lastInsertRowid);

  const fin = calcularHoraFin(fichaje.hora_entrada, worker.horas_dia);
  const finDisplay = fin.toLocaleTimeString('es-ES', { timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit' });

  res.json({
    estado: 'en_jornada',
    fichaje,
    hora_fin_prevista: fin.toISOString(),
    hora_fin_display: finDisplay,
    mensaje: `Jornada iniciada. Tu jornada finaliza hoy a las ${finDisplay}. ¡Buena jornada!`,
  });
});

// GET /api/historial — historial del mes en curso
app.get('/api/historial', authWorker, (req, res) => {
  const mesActual = todayMadrid().slice(0, 7);
  const historial = queries.getHistorialMes.all(nowMadrid(), req.user.id, mesActual);
  const worker = queries.getTrabajadoraById.get(req.user.id);

  const totalHoras = historial
    .filter(f => f.hora_salida)
    .reduce((acc, f) => acc + (f.horas_trabajadas || 0), 0);

  res.json({
    fichajes: historial,
    total_horas: Math.round(totalHoras * 100) / 100,
    horas_dia_contrato: worker.horas_dia,
    dias_mes_contrato: worker.dias_mes,
  });
});

// ─── RUTAS DE ADMINISTRACIÓN ─────────────────────────────────────────────────────

// GET /api/admin/dashboard — vista general de todas las empresas
app.get('/api/admin/dashboard', authAdmin, (req, res) => {
  const empresas = queries.getAllEmpresas.all();
  const hoy = todayMadrid();

  const result = empresas.map(emp => {
    const trabajadoras = queries.getEstadoHoyByEmpresa.all(hoy, emp.id);
    const stats = {
      total: trabajadoras.length,
      fichadas: 0,
      jornada_completada: 0,
      sin_fichar: 0,
      it_baja: 0,
      alerta: 0,
    };

    trabajadoras.forEach(t => {
      if (t.estado === 'IT' || t.estado === 'baja' || t.estado === 'vacaciones') {
        stats.it_baja++;
      } else if (t.hora_entrada && !t.hora_salida) {
        stats.fichadas++;
      } else if (t.hora_salida) {
        stats.jornada_completada++;
      } else {
        stats.sin_fichar++;
        stats.alerta++;
      }
    });

    return { empresa: emp, stats, trabajadoras };
  });

  res.json({ fecha: hoy, empresas: result });
});

// GET /api/admin/empresas — lista de empresas
app.get('/api/admin/empresas', authAdmin, (req, res) => {
  res.json(queries.getAllEmpresas.all());
});

// GET /api/admin/empresas/:id/trabajadoras — trabajadoras de empresa con estado hoy
app.get('/api/admin/empresas/:id/trabajadoras', authAdmin, (req, res) => {
  const trabajadoras = queries.getEstadoHoyByEmpresa.all(req.params.id);
  res.json(trabajadoras);
});

// GET /api/admin/trabajadoras — todas las trabajadoras
app.get('/api/admin/trabajadoras', authAdmin, (req, res) => {
  res.json(queries.getAllTrabajadoras.all());
});

// GET /api/admin/trabajadoras/:id — detalle de trabajadora
app.get('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const t = queries.getTrabajadoraById.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrada' });
  res.json(t);
});

// POST /api/admin/trabajadoras — alta nueva trabajadora
app.post('/api/admin/trabajadoras', authAdmin, async (req, res) => {
  const { empresa_id, nombre, dni, telefono, horas_dia, dias_mes,
          tipo_jornada, estado, observaciones, pin } = req.body;

  if (!empresa_id || !nombre || !dni || !horas_dia) {
    return res.status(400).json({ error: 'Faltan campos obligatorios' });
  }

  const dniUpper = dni.trim().toUpperCase();
  const pinHash = await bcrypt.hash(pin || defaultPin(dniUpper), 10);

  try {
    const result = queries.insertTrabajadora.run({
      empresa_id, nombre, dni: dniUpper, pin: pinHash,
      telefono: telefono || null,
      horas_dia: parseFloat(horas_dia),
      dias_mes: parseInt(dias_mes) || 30,
      tipo_jornada: tipo_jornada || 'completa',
      estado: estado || 'activa',
      observaciones: observaciones || null,
    });
    queries.insertAudit.run(req.user.username, 'ALTA_TRABAJADORA', 'trabajadoras',
      result.lastInsertRowid, null, JSON.stringify(req.body));
    res.json({ id: result.lastInsertRowid, mensaje: 'Trabajadora dada de alta correctamente' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'DNI ya existe en el sistema' });
    }
    throw err;
  }
});

// PUT /api/admin/trabajadoras/:id — modificar trabajadora
app.put('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });

  const { nombre, telefono, horas_dia, dias_mes, tipo_jornada,
          estado, observaciones, horas_pendientes_confirmar } = req.body;

  queries.updateTrabajadora.run({
    id: req.params.id,
    nombre:    nombre    ?? prev.nombre,
    telefono:  telefono  ?? prev.telefono,
    horas_dia: horas_dia != null ? parseFloat(horas_dia) : prev.horas_dia,
    dias_mes:  dias_mes  != null ? parseInt(dias_mes) : prev.dias_mes,
    tipo_jornada: tipo_jornada ?? prev.tipo_jornada,
    estado:    estado    ?? prev.estado,
    observaciones: observaciones ?? prev.observaciones,
    pendiente: horas_pendientes_confirmar != null ? (horas_pendientes_confirmar ? 1 : 0) : prev.horas_pendientes_confirmar,
  });

  queries.insertAudit.run(req.user.username, 'MODIFICACION_TRABAJADORA', 'trabajadoras',
    req.params.id, JSON.stringify(prev), JSON.stringify(req.body));

  res.json({ mensaje: 'Actualizado correctamente' });
});

// POST /api/admin/trabajadoras/:id/reset-pin — resetear PIN
app.post('/api/admin/trabajadoras/:id/reset-pin', authAdmin, async (req, res) => {
  const { nuevo_pin } = req.body;
  if (!nuevo_pin || String(nuevo_pin).length !== 4) {
    return res.status(400).json({ error: 'El PIN debe tener exactamente 4 dígitos' });
  }
  const hash = await bcrypt.hash(String(nuevo_pin), 10);
  queries.updatePin.run(hash, req.params.id);
  queries.insertAudit.run(req.user.username, 'RESET_PIN', 'trabajadoras', req.params.id, null, null);
  res.json({ mensaje: 'PIN actualizado' });
});

// DELETE /api/admin/trabajadoras/:id — dar de baja (soft delete)
app.delete('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });
  queries.deactivateTrabajadora.run(req.params.id);
  queries.insertAudit.run(req.user.username, 'BAJA_TRABAJADORA', 'trabajadoras',
    req.params.id, JSON.stringify(prev), JSON.stringify({ activa: 0 }));
  res.json({ mensaje: 'Trabajadora dada de baja' });
});

// GET /api/admin/fichajes — historial con filtros
app.get('/api/admin/fichajes', authAdmin, (req, res) => {
  const { empresa_id, trabajadora_id, fecha_inicio, fecha_fin } = req.query;
  const fichajes = queries.getHistorialRango.all({
    empresa_id:    empresa_id    ? parseInt(empresa_id)    : null,
    trabajadora_id: trabajadora_id ? parseInt(trabajadora_id) : null,
    fecha_inicio:  fecha_inicio  || null,
    fecha_fin:     fecha_fin     || null,
  });
  res.json(fichajes);
});

// PUT /api/admin/fichajes/:id — corregir fichaje (solo admin, con auditoría)
app.put('/api/admin/fichajes/:id', authAdmin, (req, res) => {
  const prev = queries.getFichajeById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Fichaje no encontrado' });

  const { hora_entrada, hora_salida, observaciones, razon } = req.body;

  if (!razon || razon.trim().length < 5) {
    return res.status(400).json({ error: 'Es obligatorio indicar el motivo de la corrección (mín. 5 caracteres)' });
  }

  let horas = prev.horas_trabajadas;
  const entradaFinal  = hora_entrada ?? prev.hora_entrada;
  const salidaFinal   = hora_salida  ?? prev.hora_salida;

  if (entradaFinal && salidaFinal) {
    horas = calcularHorasTrabajadas(entradaFinal, salidaFinal);
  }

  queries.updateFichaje.run({
    id: req.params.id,
    hora_entrada:    entradaFinal,
    hora_salida:     salidaFinal,
    horas_trabajadas: horas,
    observaciones:   observaciones ?? prev.observaciones,
    admin:           req.user.username,
    modificado_en:   nowMadrid(),
    razon:           razon.trim(),
  });

  queries.insertAudit.run(req.user.username, 'CORRECCION_FICHAJE', 'fichajes',
    req.params.id, JSON.stringify(prev), JSON.stringify(req.body));

  res.json({ mensaje: 'Fichaje corregido' });
});

// GET /api/admin/informe-pdf/:trabajadora_id/:anio/:mes — exportar PDF registro de jornada
app.get('/api/admin/informe-pdf/:trabajadora_id/:anio/:mes', authAdmin, (req, res) => {
  const { trabajadora_id, anio, mes } = req.params;
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const fichajes = queries.getInformeMensual.all(trabajadora_id, periodo);

  if (!fichajes.length) {
    return res.status(404).json({ error: 'Sin registros para ese periodo' });
  }

  const info = fichajes[0];
  const mesNombre = new Date(`${periodo}-01`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });

  const doc = new PDFDoc({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition',
    `attachment; filename="registro_jornada_${info.dni}_${periodo}.pdf"`);
  doc.pipe(res);

  // ── Cabecera ──
  doc.fontSize(14).font('Helvetica-Bold')
     .text('REGISTRO DE JORNADA', { align: 'center' });
  doc.fontSize(9).font('Helvetica')
     .text('(Art. 34.9 Estatuto de los Trabajadores — RD-ley 8/2019)', { align: 'center' });
  doc.moveDown(0.5);

  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Datos empresa/trabajadora ──
  const col1 = 40, col2 = 300;
  doc.fontSize(9).font('Helvetica-Bold').text('EMPRESA:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${info.empresa_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('NIF/CIF:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${info.empresa_nif}`);
  doc.fontSize(9).font('Helvetica-Bold').text('CCC:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${info.ccc}`);
  doc.moveDown(0.3);

  const y2 = doc.y;
  doc.fontSize(9).font('Helvetica-Bold').text('TRABAJADORA/OR:', col1, y2, { continued: true })
     .font('Helvetica').text(` ${info.trabajadora_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('DNI/NIE:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${info.dni}`);
  doc.fontSize(9).font('Helvetica-Bold').text('TIPO JORNADA:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${info.tipo_jornada === 'completa' ? 'Tiempo completo' : 'Tiempo parcial'}`);
  doc.fontSize(9).font('Helvetica-Bold').text('PERÍODO:', col1, doc.y, { continued: true })
     .font('Helvetica').text(` ${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)}`);

  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  // ── Tabla de fichajes ──
  const colWidths = [70, 75, 75, 60, 225];
  const headers   = ['FECHA', 'ENTRADA', 'SALIDA', 'HORAS', 'OBSERVACIONES'];
  const colX      = [40, 110, 185, 260, 320];

  // Cabecera tabla
  doc.fontSize(8).font('Helvetica-Bold');
  headers.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: colWidths[i] }));
  doc.moveDown(0.2);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.1);

  // Filas
  let totalHoras = 0;
  let diasTrabajados = 0;

  doc.font('Helvetica').fontSize(8);
  fichajes.forEach(f => {
    const y = doc.y;

    const fechaStr = new Date(f.fecha + 'T12:00:00').toLocaleDateString('es-ES', {
      weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric',
    });

    let horasStr = '';
    if (f.horas_trabajadas != null) {
      horasStr = decimalToHHMM(f.horas_trabajadas);
      totalHoras += f.horas_trabajadas;
      diasTrabajados++;
    }

    const obs = [];
    if (f.cerrado_automaticamente) obs.push('Cierre auto.');
    if (f.observaciones) obs.push(f.observaciones);
    if (f.modificado_por) obs.push(`Corr.admin: ${f.razon_modificacion || ''}`);

    doc.text(fechaStr,        colX[0], y, { width: colWidths[0] });
    doc.text(horaDisplay(f.hora_entrada), colX[1], y, { width: colWidths[1] });
    doc.text(horaDisplay(f.hora_salida),  colX[2], y, { width: colWidths[2] });
    doc.text(horasStr,        colX[3], y, { width: colWidths[3] });
    doc.text(obs.join('; '),  colX[4], y, { width: colWidths[4] });

    doc.moveDown(0.15);

    if (doc.y > 750) {
      doc.addPage();
    }
  });

  // Totales
  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text(`Días trabajados: ${diasTrabajados}`, colX[0]);
  doc.text(`TOTAL HORAS MES: ${decimalToHHMM(totalHoras)} (${Math.round(totalHoras * 100) / 100}h)`,
           colX[0]);

  // Jornada contrato
  const jornadaContrato = fichajes[0]?.horas_dia;
  if (jornadaContrato) {
    const expectedHoras = jornadaContrato * diasTrabajados;
    const diff = Math.round((totalHoras - expectedHoras) * 100) / 100;
    doc.font('Helvetica').fontSize(8)
       .text(`Horas contrato/día: ${decimalToHHMM(jornadaContrato)} · Esperadas este período: ${decimalToHHMM(expectedHoras)} · Diferencia: ${diff >= 0 ? '+' : ''}${decimalToHHMM(Math.abs(diff))}`);
  }

  // Pie legal
  doc.moveDown(1);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);
  doc.fontSize(7).font('Helvetica')
     .text('Este registro ha sido generado automáticamente por el sistema de control horario de Webgest. ' +
           'Se conservará durante un mínimo de 4 años conforme al art. 34.9 ET. ' +
           'Disponible para la persona trabajadora, sus representantes legales y la Inspección de Trabajo.',
           { align: 'justify' });

  // Firma
  doc.moveDown(2);
  doc.fontSize(8)
     .text('Firma de la empresa:', 40)
     .text('Firma de la trabajadora/or:', 300);

  doc.end();
});

// GET /api/admin/audit — log de auditoría
app.get('/api/admin/audit', authAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200
  `).all();
  res.json(rows);
});

// ─── CRON JOB — AUTOCIERRE DE JORNADA ────────────────────────────────────────────

cron.schedule('* * * * *', () => {
  const abiertos = queries.getFichajesAbiertos.all();
  const ahora = new Date();

  abiertos.forEach(f => {
    const finPrevisto = calcularHoraFin(f.hora_entrada, f.horas_dia);
    if (ahora >= finPrevisto) {
      // Convertir el fin previsto a hora local Madrid (no toISOString que devuelve UTC)
      const salidaISO = finPrevisto.toLocaleString('sv-SE', { timeZone: 'Europe/Madrid' }).slice(0, 19);
      const horas = calcularHorasTrabajadas(f.hora_entrada, salidaISO);

      queries.closeFichaje.run(salidaISO, horas, 1, f.id);

      const horaDisplay = finPrevisto.toLocaleTimeString('es-ES', {
        timeZone: 'Europe/Madrid', hour: '2-digit', minute: '2-digit',
      });

      console.log(`[CRON] Jornada cerrada automáticamente: ${f.trabajadora_nombre} a las ${horaDisplay}`);

      // Enviar SMS
      smsFin(f.telefono, finPrevisto);
    }
  });
});

// ─── RUTAS SPA (fallback) ────────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ARRANCAR SERVIDOR ───────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`✅ Control Horario Webgest corriendo en http://localhost:${PORT}`);
  console.log(`   Panel trabajadora: http://localhost:${PORT}/`);
  console.log(`   Panel admin:       http://localhost:${PORT}/admin`);
  console.log(`   Zona horaria:      ${process.env.TZ}`);
});

// ─── HELPERS locales ────────────────────────────────────────────────────────────

function defaultPin(dni) {
  const digits = dni.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '1234';
}
