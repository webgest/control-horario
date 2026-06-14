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
const fs       = require('fs');

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

const TZ = 'Europe/Madrid';

// Calcula el offset UTC de España en horas (+1 CET, +2 CEST).
// Usa aritmética pura UTC para no depender de ICU ni tzdata en el contenedor.
function spainOffsetHours(d) {
  const d_ = d || new Date();
  const y = d_.getUTCFullYear();
  // CEST: último domingo de marzo a las 01:00 UTC
  const cest = new Date(Date.UTC(y, 2, 31, 1, 0, 0));
  while (cest.getUTCDay() !== 0) cest.setUTCDate(cest.getUTCDate() - 1);
  // CET: último domingo de octubre a las 01:00 UTC
  const cet = new Date(Date.UTC(y, 9, 31, 1, 0, 0));
  while (cet.getUTCDay() !== 0) cet.setUTCDate(cet.getUTCDate() - 1);
  return (d_ >= cest && d_ < cet) ? 2 : 1;
}

function nowLocalISO() {
  const d = new Date();
  const local = new Date(d.getTime() + spainOffsetHours(d) * 3600000);
  return local.toISOString().slice(0, 19).replace('T', ' ');
}

function todayLocal() {
  const d = new Date();
  const local = new Date(d.getTime() + spainOffsetHours(d) * 3600000);
  return local.toISOString().slice(0, 10);
}

// Formatea un Date como "HH:MM" en hora de Madrid (sin depender de ICU)
function horaDisplay_Madrid(d) {
  const local = new Date(d.getTime() + spainOffsetHours(d) * 3600000);
  return local.toISOString().slice(11, 16);
}

// Calcula horas de déficit acumuladas en el mes actual para una trabajadora.
// Solo cuenta días ya cerrados (excluyendo hoy). Devuelve 0 si tienen superávit.
function calcularDeficitMes(trabajadoraId, horasDia) {
  const hoy = todayLocal();
  const mes = hoy.slice(0, 7);
  const r = db.prepare(
    `SELECT COALESCE(SUM(horas_trabajadas),0) AS total_h, COUNT(*) AS dias
     FROM fichajes
     WHERE trabajadora_id=? AND strftime('%Y-%m',fecha)=? AND hora_salida IS NOT NULL AND fecha<?`
  ).get(trabajadoraId, mes, hoy);
  const deficit = (horasDia * r.dias) - r.total_h;
  return deficit > 0 ? Math.round(deficit * 1000) / 1000 : 0;
}

// ─── RUTAS PÚBLICAS ──────────────────────────────────────────────────────────────

// GET /api/trabajadoras-publico — lista de empresas y trabajadoras (sin datos sensibles)
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

// POST /api/auth/login — trabajadora sin contraseña (solo ID)
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
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });

  const admin = queries.getAdminByUsername.get(username.trim());
  if (!admin) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const ok = await bcrypt.compare(password, admin.password);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });

  const token = jwt.sign(
    { id: admin.id, role: 'admin', username: admin.username, nombre: admin.nombre },
    SECRET,
    { expiresIn: '8h' }
  );

  res.json({ token, nombre: admin.nombre, username: admin.username });
});

// ─── RUTAS DE TRABAJADORA ────────────────────────────────────────────────────────

app.get('/api/fichar/estado', authWorker, (req, res) => {
  const hoy    = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayLocal());
  const worker = queries.getTrabajadoraById.get(req.user.id);

  if (!hoy) return res.json({ estado: 'sin_fichar', fichaje: null, horas_dia: worker.horas_dia });

  if (!hoy.hora_salida) {
    const totalPausasH = queries.getTotalPausasH.get(nowLocalISO(), hoy.id).total;
    const pausaActiva  = queries.getPausaActiva.get(hoy.id);
    const deficit      = calcularDeficitMes(req.user.id, worker.horas_dia);
    const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia + deficit + totalPausasH);
    return res.json({
      estado: pausaActiva ? 'en_pausa' : 'en_jornada',
      fichaje: hoy,
      hora_fin_prevista: fin.toISOString(),
      hora_fin_display: horaDisplay_Madrid(fin),
      en_pausa: !!pausaActiva,
      total_pausas_h: Math.round(totalPausasH * 100) / 100,
      deficit_hoy: Math.round(deficit * 100) / 100,
    });
  }

  return res.json({ estado: 'jornada_completada', fichaje: hoy });
});

app.post('/api/fichar/entrada', authWorker, (req, res) => {
  const worker = queries.getTrabajadoraById.get(req.user.id);
  if (!worker) return res.status(404).json({ error: 'Trabajadora no encontrada' });

  if (worker.estado === 'IT' || worker.estado === 'baja') {
    return res.status(403).json({ error: `No puedes fichar: estás en situación de ${worker.estado}.` });
  }

  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayLocal());

  if (hoy && hoy.hora_salida) {
    return res.status(409).json({ error: 'Ya has completado tu jornada de hoy.' });
  }

  if (hoy && !hoy.hora_salida) {
    const deficit = calcularDeficitMes(req.user.id, worker.horas_dia);
    const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia + deficit);
    return res.json({
      estado: 'en_jornada', fichaje: hoy,
      hora_fin_prevista: fin.toISOString(),
      hora_fin_display: horaDisplay_Madrid(fin),
      deficit_hoy: Math.round(deficit * 100) / 100,
      mensaje: `Ya tienes la jornada iniciada. Finaliza a las ${horaDisplay_Madrid(fin)}.`,
    });
  }

  const result  = queries.createFichaje.run(req.user.id, todayLocal(), nowLocalISO());
  const fichaje = queries.getFichajeById.get(result.lastInsertRowid);
  const deficit = calcularDeficitMes(req.user.id, worker.horas_dia);
  const fin     = calcularHoraFin(fichaje.hora_entrada, worker.horas_dia + deficit);
  const finDisplay = horaDisplay_Madrid(fin);

  res.json({
    estado: 'en_jornada', fichaje,
    hora_fin_prevista: fin.toISOString(),
    hora_fin_display: finDisplay,
    deficit_hoy: Math.round(deficit * 100) / 100,
    mensaje: `Jornada iniciada. Tu jornada finaliza hoy a las ${finDisplay}. ¡Buena jornada!`,
  });
});

// ── PAUSA ──────────────────────────────────────────────────────────────────────
app.post('/api/fichar/pausa', authWorker, (req, res) => {
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayLocal());
  if (!hoy || hoy.hora_salida) return res.status(400).json({ error: 'No tienes jornada activa.' });

  const pausaActiva = queries.getPausaActiva.get(hoy.id);
  if (pausaActiva) return res.status(409).json({ error: 'Ya tienes una pausa activa. Reanuda primero.' });

  queries.insertPausa.run(hoy.id, nowLocalISO());
  const totalPausasH = queries.getTotalPausasH.get(nowLocalISO(), hoy.id).total;
  const worker = queries.getTrabajadoraById.get(req.user.id);
  const deficit = calcularDeficitMes(req.user.id, worker.horas_dia);
  const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia + deficit + totalPausasH);
  res.json({
    ok: true,
    estado: 'en_pausa',
    fichaje: hoy,
    mensaje: 'Pausa iniciada. Pulsa REANUDAR cuando vuelvas.',
    hora_fin_prevista: fin.toISOString(),
    hora_fin_display: horaDisplay_Madrid(fin),
    en_pausa: true,
    deficit_hoy: Math.round(deficit * 100) / 100,
  });
});

app.post('/api/fichar/reanudar', authWorker, (req, res) => {
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayLocal());
  if (!hoy || hoy.hora_salida) return res.status(400).json({ error: 'No tienes jornada activa.' });

  const pausaActiva = queries.getPausaActiva.get(hoy.id);
  if (!pausaActiva) return res.status(409).json({ error: 'No tienes ninguna pausa activa.' });

  queries.cerrarPausa.run(nowLocalISO(), hoy.id);
  const totalPausasH = queries.getTotalPausasH.get(nowLocalISO(), hoy.id).total;
  const worker = queries.getTrabajadoraById.get(req.user.id);
  const deficit = calcularDeficitMes(req.user.id, worker.horas_dia);
  const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia + deficit + totalPausasH);
  const finDisplay = horaDisplay_Madrid(fin);
  res.json({
    ok: true,
    estado: 'en_jornada',
    fichaje: hoy,
    mensaje: `Bienvenida de nuevo. Tu jornada finaliza ahora a las ${finDisplay}.`,
    hora_fin_prevista: fin.toISOString(),
    hora_fin_display: finDisplay,
    en_pausa: false,
    deficit_hoy: Math.round(deficit * 100) / 100,
  });
});

// ── FINALIZAR JORNADA ANTES (trabajadora) ──────────────────────────────────────
app.post('/api/fichar/salida', authWorker, (req, res) => {
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id, todayLocal());
  if (!hoy) return res.status(404).json({ error: 'No tienes jornada iniciada hoy.' });
  if (hoy.hora_salida) return res.status(409).json({ error: 'Tu jornada ya está cerrada.' });

  // Cerrar pausa activa si la hay
  const pausaActiva = queries.getPausaActiva.get(hoy.id);
  if (pausaActiva) queries.cerrarPausa.run(nowLocalISO(), hoy.id);

  const s  = nowLocalISO();
  const ht = calcularHorasTrabajadas(hoy.hora_entrada, s);
  queries.closeFichaje.run(s, ht, 0, hoy.id);
  const updated = queries.getFichajeById.get(hoy.id);
  const horaFmt = s.slice(11, 16);
  res.json({
    estado: 'jornada_completada',
    fichaje: updated,
    mensaje: `Jornada finalizada a las ${horaFmt}. ¡Descansa, hasta mañana!`,
  });
});

app.get('/api/historial', authWorker, (req, res) => {
  const historial    = queries.getHistorialMes.all(nowLocalISO(), req.user.id, todayLocal().slice(0, 7));
  const worker       = queries.getTrabajadoraById.get(req.user.id);
  const totalHoras   = historial.filter(f => f.hora_salida).reduce((a, f) => a + (f.horas_trabajadas || 0), 0);
  res.json({
    fichajes: historial,
    total_horas: Math.round(totalHoras * 100) / 100,
    horas_dia_contrato: worker.horas_dia,
    dias_mes_contrato: worker.dias_mes,
  });
});

// ─── RUTAS DE ADMINISTRACIÓN ─────────────────────────────────────────────────────

app.get('/api/admin/dashboard', authAdmin, (req, res) => {
  const empresas = queries.getAllEmpresas.all();
  const result = empresas.map(emp => {
    const trabajadoras = queries.getEstadoHoyByEmpresa.all(todayLocal(), emp.id);
    const stats = { total: 0, fichadas: 0, jornada_completada: 0, sin_fichar: 0, it_baja: 0, alerta: 0 };
    stats.total = trabajadoras.length;
    trabajadoras.forEach(t => {
      if (['IT','baja','vacaciones'].includes(t.estado)) stats.it_baja++;
      else if (t.hora_entrada && !t.hora_salida)         stats.fichadas++;
      else if (t.hora_salida)                            stats.jornada_completada++;
      else                                               { stats.sin_fichar++; stats.alerta++; }
    });
    return { empresa: emp, stats, trabajadoras };
  });
  res.json({ fecha: todayLocal(), empresas: result });
});

app.get('/api/admin/empresas', authAdmin, (req, res) => res.json(queries.getAllEmpresas.all()));

app.get('/api/admin/empresas/:id/trabajadoras', authAdmin, (req, res) =>
  res.json(queries.getEstadoHoyByEmpresa.all(todayLocal(), req.params.id)));

app.get('/api/admin/trabajadoras', authAdmin, (req, res) =>
  res.json(queries.getAllTrabajadoras.all()));

app.get('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const t = queries.getTrabajadoraById.get(req.params.id);
  if (!t) return res.status(404).json({ error: 'No encontrada' });
  res.json(t);
});

app.post('/api/admin/trabajadoras', authAdmin, async (req, res) => {
  const { empresa_id, nombre, dni, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones } = req.body;
  if (!empresa_id || !nombre || !dni || !horas_dia)
    return res.status(400).json({ error: 'Faltan campos obligatorios' });

  const dniUpper = dni.trim().toUpperCase();
  const digits   = dniUpper.replace(/[^0-9]/g, '');
  const pinHash  = await bcrypt.hash(digits.length >= 4 ? digits.slice(-4) : '1234', 10);

  const crypto = require('crypto');
  const tokenAcceso = crypto.randomBytes(5).toString('hex');

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
    db.prepare('UPDATE trabajadoras SET token_acceso = ? WHERE id = ?').run(tokenAcceso, result.lastInsertRowid);
    queries.insertAudit.run(req.user.username, 'ALTA_TRABAJADORA', 'trabajadoras', result.lastInsertRowid, null, JSON.stringify(req.body));
    res.json({ id: result.lastInsertRowid, mensaje: 'Trabajadora dada de alta correctamente' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'DNI ya existe en el sistema' });
    throw err;
  }
});

app.put('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });
  const { nombre, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones, horas_pendientes_confirmar } = req.body;
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
  queries.insertAudit.run(req.user.username, 'MODIFICACION_TRABAJADORA', 'trabajadoras', req.params.id, JSON.stringify(prev), JSON.stringify(req.body));
  res.json({ mensaje: 'Actualizado correctamente' });
});

app.delete('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });
  queries.deactivateTrabajadora.run(req.params.id);
  queries.insertAudit.run(req.user.username, 'BAJA_TRABAJADORA', 'trabajadoras', req.params.id, JSON.stringify(prev), null);
  res.json({ mensaje: 'Trabajadora dada de baja' });
});

app.get('/api/admin/fichajes', authAdmin, (req, res) => {
  const { empresa_id, trabajadora_id, fecha_inicio, fecha_fin } = req.query;
  res.json(queries.getHistorialRango.all({
    empresa_id:     empresa_id     ? parseInt(empresa_id)     : null,
    trabajadora_id: trabajadora_id ? parseInt(trabajadora_id) : null,
    fecha_inicio:   fecha_inicio   || null,
    fecha_fin:      fecha_fin      || null,
  }));
});

app.delete('/api/admin/fichajes/:id', authAdmin, (req, res) => {
  const prev = queries.getFichajeById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Fichaje no encontrado' });
  db.prepare('DELETE FROM fichajes WHERE id=?').run(req.params.id);
  queries.insertAudit.run(req.user.username, 'BORRAR_FICHAJE', 'fichajes', req.params.id, JSON.stringify(prev), null);
  res.json({ ok: true, mensaje: 'Fichaje eliminado correctamente.' });
});

app.put('/api/admin/fichajes/:id', authAdmin, (req, res) => {
  const prev = queries.getFichajeById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'Fichaje no encontrado' });
  const { hora_entrada, hora_salida, observaciones, razon } = req.body;
  if (!razon || razon.trim().length < 5)
    return res.status(400).json({ error: 'El motivo de la corrección es obligatorio (mín. 5 caracteres)' });

  const entradaFinal = hora_entrada ?? prev.hora_entrada;
  const salidaFinal  = hora_salida  ?? prev.hora_salida;
  const horas = (entradaFinal && salidaFinal) ? calcularHorasTrabajadas(entradaFinal, salidaFinal) : prev.horas_trabajadas;

  queries.updateFichaje.run({ id: req.params.id, hora_entrada: entradaFinal, hora_salida: salidaFinal, horas_trabajadas: horas, observaciones: observaciones ?? prev.observaciones, admin: req.user.username, modificado_en: nowLocalISO(), razon: razon.trim() });
  queries.insertAudit.run(req.user.username, 'CORRECCION_FICHAJE', 'fichajes', req.params.id, JSON.stringify(prev), JSON.stringify(req.body));
  res.json({ mensaje: 'Fichaje corregido' });
});

app.get('/api/admin/informe-pdf/:trabajadora_id/:anio/:mes', authAdmin, (req, res) => {
  const { trabajadora_id, anio, mes } = req.params;
  const periodo  = `${anio}-${String(mes).padStart(2, '0')}`;
  const fichajes = queries.getInformeMensual.all(trabajadora_id, periodo);
  if (!fichajes.length) return res.status(404).json({ error: 'Sin registros para ese periodo' });

  const info      = fichajes[0];
  const mesNombre = new Date(`${periodo}-01`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const doc       = new PDFDoc({ margin: 40, size: 'A4' });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="registro_jornada_${info.dni}_${periodo}.pdf"`);
  doc.pipe(res);

  doc.fontSize(14).font('Helvetica-Bold').text('REGISTRO DE JORNADA', { align: 'center' });
  doc.fontSize(9).font('Helvetica').text('(Art. 34.9 Estatuto de los Trabajadores — RD-ley 8/2019)', { align: 'center' });
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  const col1 = 40;
  doc.fontSize(9).font('Helvetica-Bold').text('EMPRESA:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.empresa_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('NIF/CIF:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.empresa_nif}`);
  doc.fontSize(9).font('Helvetica-Bold').text('CCC:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.ccc}`);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica-Bold').text('TRABAJADORA/OR:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.trabajadora_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('DNI/NIE:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.dni}`);
  doc.fontSize(9).font('Helvetica-Bold').text('TIPO JORNADA:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${info.tipo_jornada === 'completa' ? 'Tiempo completo' : 'Tiempo parcial'}`);
  doc.fontSize(9).font('Helvetica-Bold').text('PERÍODO:', col1, doc.y, { continued: true }).font('Helvetica').text(` ${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)}`);
  doc.moveDown(0.5);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);

  const colX = [40, 110, 185, 260, 320];
  const colW = [70, 75, 75, 60, 225];
  const hdrs = ['FECHA', 'ENTRADA', 'SALIDA', 'HORAS', 'OBSERVACIONES'];
  doc.fontSize(8).font('Helvetica-Bold');
  hdrs.forEach((h, i) => doc.text(h, colX[i], doc.y, { width: colW[i] }));
  doc.moveDown(0.2);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.1);

  let totalHoras = 0, diasTrabajados = 0;
  doc.font('Helvetica').fontSize(8);
  fichajes.forEach(f => {
    const y = doc.y;
    const fechaStr = new Date(f.fecha + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    let horasStr = '';
    if (f.horas_trabajadas != null) { horasStr = decimalToHHMM(f.horas_trabajadas); totalHoras += f.horas_trabajadas; diasTrabajados++; }
    const obs = [f.cerrado_automaticamente ? 'Cierre auto.' : '', f.observaciones || '', f.modificado_por ? `Corr: ${f.razon_modificacion || ''}` : ''].filter(Boolean).join('; ');
    doc.text(fechaStr, colX[0], y, { width: colW[0] });
    doc.text(horaDisplay(f.hora_entrada), colX[1], y, { width: colW[1] });
    doc.text(horaDisplay(f.hora_salida),  colX[2], y, { width: colW[2] });
    doc.text(horasStr,  colX[3], y, { width: colW[3] });
    doc.text(obs,       colX[4], y, { width: colW[4] });
    doc.moveDown(0.15);
    if (doc.y > 750) doc.addPage();
  });

  doc.moveDown(0.3);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Bold');
  doc.text(`Días trabajados: ${diasTrabajados}`, col1);
  doc.text(`TOTAL HORAS MES: ${decimalToHHMM(totalHoras)} (${Math.round(totalHoras * 100) / 100}h)`, col1);
  doc.moveDown(1);
  doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
  doc.moveDown(0.3);
  doc.fontSize(7).font('Helvetica').text('Registro generado por sistema de control horario Webgest. Conservación mínima 4 años (art. 34.9 ET). Disponible para trabajadoras, representantes y la ITSS.', { align: 'justify' });
  doc.moveDown(2);
  doc.fontSize(8).text('Firma de la empresa:', 40).text('Firma de la trabajadora/or:', 300);
  doc.end();
});

app.get('/api/admin/audit', authAdmin, (req, res) =>
  res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all()));

// ─── CRON JOB ────────────────────────────────────────────────────────────────────

cron.schedule('* * * * *', () => {
  const abiertos = queries.getFichajesAbiertos.all();
  const ahora    = new Date();
  abiertos.forEach(f => {
    const pausaActiva  = queries.getPausaActiva.get(f.id);
    const totalPausasH = queries.getTotalPausasH.get(nowLocalISO(), f.id).total;
    const deficit      = calcularDeficitMes(f.trabajadora_id, f.horas_dia);
    const fin = calcularHoraFin(f.hora_entrada, f.horas_dia + deficit + totalPausasH);
    if (ahora >= fin) {
      if (pausaActiva) queries.cerrarPausa.run(nowLocalISO(), f.id);
      const salidaLocal = new Date(fin.getTime() + spainOffsetHours(fin) * 3600000);
      const salidaISO   = salidaLocal.toISOString().slice(0, 19).replace('T', ' ');
      queries.closeFichaje.run(salidaISO, calcularHorasTrabajadas(f.hora_entrada, salidaISO), 1, f.id);
      console.log(`[CRON] Cierre automático: ${f.trabajadora_nombre} a las ${horaDisplay_Madrid(fin)}${deficit > 0 ? ` (+${decimalToHHMM(deficit)} compensación)` : ''}`);
      smsFin(f.telefono, horaDisplay_Madrid(fin));
    }
  });
});

// ─── ENLACES DIRECTOS / QR ───────────────────────────────────────────────────────

// GET /api/worker-token/:token — login por enlace personal o QR
app.get('/api/worker-token/:token', (req, res) => {
  const worker = db.prepare(
    `SELECT t.*, e.nombre AS empresa_nombre FROM trabajadoras t
     JOIN empresas e ON t.empresa_id = e.id
     WHERE t.token_acceso = ? AND t.activa = 1`
  ).get(req.params.token);
  if (!worker) return res.status(404).json({ error: 'Enlace no válido o trabajadora inactiva' });
  const jwtToken = jwt.sign(
    { id: worker.id, role: 'worker', nombre: worker.nombre, empresa: worker.empresa_nombre },
    SECRET,
    { expiresIn: '24h' }
  );
  res.json({ token: jwtToken, nombre: worker.nombre, empresa: worker.empresa_nombre });
});

// POST /api/admin/empresas — crear nueva empresa
app.post('/api/admin/empresas', authAdmin, (req, res) => {
  const { nombre, nif, ccc } = req.body;
  if (!nombre || !nif || !ccc) return res.status(400).json({ error: 'Nombre, NIF y CCC obligatorios' });
  const result = db.prepare('INSERT INTO empresas (nombre, nif, ccc) VALUES (?, ?, ?)').run(nombre, nif, ccc);
  queries.insertAudit.run(req.user.username, 'ALTA_EMPRESA', 'empresas', result.lastInsertRowid, null, JSON.stringify(req.body));
  res.json({ id: result.lastInsertRowid, mensaje: 'Empresa creada' });
});

// POST /api/admin/trabajadoras/:id/regenerate-token — renovar enlace personal
app.post('/api/admin/trabajadoras/:id/regenerate-token', authAdmin, (req, res) => {
  const crypto = require('crypto');
  const newToken = crypto.randomBytes(5).toString('hex');
  db.prepare('UPDATE trabajadoras SET token_acceso = ? WHERE id = ?').run(newToken, req.params.id);
  queries.insertAudit.run(req.user.username, 'REGENERAR_TOKEN', 'trabajadoras', req.params.id, null, JSON.stringify({ token_acceso: newToken }));
  res.json({ token_acceso: newToken, mensaje: 'Enlace regenerado correctamente' });
});

// ─── SPA FALLBACK ────────────────────────────────────────────────────────────────

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*',     (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ─── ARRANCAR ────────────────────────────────────────────────────────────────────

app.listen(PORT, '0.0.0.0', () => {
  console.log(`✅ Control Horario Webgest en http://0.0.0.0:${PORT}`);
});
