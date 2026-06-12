'use strict';

try {
  require('fs').readFileSync('.env', 'utf8').split('\n').filter(l => l && !l.startsWith('#')).forEach(l => { const [k, ...v] = l.split('='); if (k && !process.env[k.trim()]) process.env[k.trim()] = v.join('=').trim(); });
} catch (_) {}

process.env.TZ = process.env.TZ || 'Europe/Madrid';

const express = require('express');
const bcrypt  = require('bcrypt');
const jwt     = require('jsonwebtoken');
const cron    = require('node-cron');
const PDFDoc  = require('pdfkit');
const path    = require('path');

const { db, queries, decimalToHHMM, calcularHoraFin, calcularHorasTrabajadas, horaDisplay } = require('./database');
const { smsFin } = require('./sms');

const app    = express();
const PORT   = parseInt(process.env.PORT || '3000');
const SECRET = process.env.JWT_SECRET || 'dev_secret_cambiar_en_produccion';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function authWorker(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin autorización' });
  try { req.user = jwt.verify(token, SECRET); if (req.user.role !== 'worker') throw new Error(); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
}

function authAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Sin autorización' });
  try { req.user = jwt.verify(token, SECRET); if (req.user.role !== 'admin') throw new Error(); next(); }
  catch { res.status(401).json({ error: 'Token inválido o expirado' }); }
}

function nowLocalISO() { const now = new Date(); return new Date(now - now.getTimezoneOffset() * 60000).toISOString().replace('T', ' ').slice(0, 19); }
function todayLocal() { return nowLocalISO().slice(0, 10); }

app.get('/api/trabajadoras-publico', (req, res) => {
  res.json(queries.getAllEmpresas.all().map(emp => ({ id: emp.id, nombre: emp.nombre, trabajadoras: db.prepare('SELECT id, nombre, estado FROM trabajadoras WHERE empresa_id = ? AND activa = 1 ORDER BY nombre').all(emp.id) })));
});

app.post('/api/auth/login', (req, res) => {
  const { trabajadora_id } = req.body || {};
  if (!trabajadora_id) return res.status(400).json({ error: 'Falta el identificador' });
  const worker = queries.getTrabajadoraById.get(parseInt(trabajadora_id));
  if (!worker || !worker.activa) return res.status(404).json({ error: 'Trabajadora no encontrada' });
  const token = jwt.sign({ id: worker.id, role: 'worker', nombre: worker.nombre, empresa: worker.empresa_nombre }, SECRET, { expiresIn: '24h' });
  res.json({ token, nombre: worker.nombre, empresa: worker.empresa_nombre, estado: worker.estado, horas_dia: worker.horas_dia, tipo_jornada: worker.tipo_jornada });
});

app.post('/api/auth/admin/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Credenciales requeridas' });
  const admin = queries.getAdminByUsername.get(username.trim());
  if (!admin) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const ok = await bcrypt.compare(password, admin.password);
  if (!ok) return res.status(401).json({ error: 'Contraseña incorrecta' });
  const token = jwt.sign({ id: admin.id, role: 'admin', username: admin.username, nombre: admin.nombre }, SECRET, { expiresIn: '8h' });
  res.json({ token, nombre: admin.nombre, username: admin.username });
});

app.get('/api/fichar/estado', authWorker, (req, res) => {
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id);
  const worker = queries.getTrabajadoraById.get(req.user.id);
  if (!hoy) return res.json({ estado: 'sin_fichar', fichaje: null, horas_dia: worker.horas_dia });
  if (!hoy.hora_salida) { const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia); return res.json({ estado: 'en_jornada', fichaje: hoy, hora_fin_prevista: fin.toISOString(), hora_fin_display: fin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) }); }
  return res.json({ estado: 'jornada_completada', fichaje: hoy });
});

app.post('/api/fichar/entrada', authWorker, (req, res) => {
  const worker = queries.getTrabajadoraById.get(req.user.id);
  if (!worker) return res.status(404).json({ error: 'Trabajadora no encontrada' });
  if (worker.estado === 'IT' || worker.estado === 'baja') return res.status(403).json({ error: `No puedes fichar: estás en ${worker.estado}.` });
  const hoy = queries.getFichajeHoyByTrabajadora.get(req.user.id);
  if (hoy && hoy.hora_salida) return res.status(409).json({ error: 'Ya has completado tu jornada de hoy.' });
  if (hoy && !hoy.hora_salida) { const fin = calcularHoraFin(hoy.hora_entrada, worker.horas_dia); return res.json({ estado: 'en_jornada', fichaje: hoy, hora_fin_prevista: fin.toISOString(), hora_fin_display: fin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }), mensaje: `Jornada ya iniciada. Finaliza a las ${fin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })}.` }); }
  const result = queries.createFichaje.run(req.user.id);
  const fichaje = queries.getFichajeById.get(result.lastInsertRowid);
  const fin = calcularHoraFin(fichaje.hora_entrada, worker.horas_dia);
  const finDisplay = fin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
  res.json({ estado: 'en_jornada', fichaje, hora_fin_prevista: fin.toISOString(), hora_fin_display: finDisplay, mensaje: `Jornada iniciada. Tu jornada finaliza hoy a las ${finDisplay}. ¡Buena jornada!` });
});

app.get('/api/historial', authWorker, (req, res) => {
  const historial = queries.getHistorialMes.all(req.user.id);
  const worker = queries.getTrabajadoraById.get(req.user.id);
  const totalHoras = historial.filter(f => f.hora_salida).reduce((a, f) => a + (f.horas_trabajadas || 0), 0);
  res.json({ fichajes: historial, total_horas: Math.round(totalHoras * 100) / 100, horas_dia_contrato: worker.horas_dia, dias_mes_contrato: worker.dias_mes });
});

app.get('/api/admin/dashboard', authAdmin, (req, res) => {
  const result = queries.getAllEmpresas.all().map(emp => {
    const trabajadoras = queries.getEstadoHoyByEmpresa.all(emp.id);
    const stats = { total: trabajadoras.length, fichadas: 0, jornada_completada: 0, sin_fichar: 0, it_baja: 0, alerta: 0 };
    trabajadoras.forEach(t => { if (['IT','baja','vacaciones'].includes(t.estado)) stats.it_baja++; else if (t.hora_entrada && !t.hora_salida) stats.fichadas++; else if (t.hora_salida) stats.jornada_completada++; else { stats.sin_fichar++; stats.alerta++; } });
    return { empresa: emp, stats, trabajadoras };
  });
  res.json({ fecha: todayLocal(), empresas: result });
});

app.get('/api/admin/empresas', authAdmin, (req, res) => res.json(queries.getAllEmpresas.all()));
app.get('/api/admin/empresas/:id/trabajadoras', authAdmin, (req, res) => res.json(queries.getEstadoHoyByEmpresa.all(req.params.id)));
app.get('/api/admin/trabajadoras', authAdmin, (req, res) => res.json(queries.getAllTrabajadoras.all()));
app.get('/api/admin/trabajadoras/:id', authAdmin, (req, res) => { const t = queries.getTrabajadoraById.get(req.params.id); if (!t) return res.status(404).json({ error: 'No encontrada' }); res.json(t); });

app.post('/api/admin/trabajadoras', authAdmin, async (req, res) => {
  const { empresa_id, nombre, dni, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones } = req.body;
  if (!empresa_id || !nombre || !dni || !horas_dia) return res.status(400).json({ error: 'Faltan campos obligatorios' });
  const dniUpper = dni.trim().toUpperCase();
  const digits = dniUpper.replace(/[^0-9]/g, '');
  const pinHash = await bcrypt.hash(digits.length >= 4 ? digits.slice(-4) : '1234', 10);
  try {
    const result = queries.insertTrabajadora.run({ empresa_id, nombre, dni: dniUpper, pin: pinHash, telefono: telefono || null, horas_dia: parseFloat(horas_dia), dias_mes: parseInt(dias_mes) || 30, tipo_jornada: tipo_jornada || 'completa', estado: estado || 'activa', observaciones: observaciones || null });
    queries.insertAudit.run(req.user.username, 'ALTA_TRABAJADORA', 'trabajadoras', result.lastInsertRowid, null, JSON.stringify(req.body));
    res.json({ id: result.lastInsertRowid, mensaje: 'Alta correcta' });
  } catch (err) { if (err.message.includes('UNIQUE')) return res.status(409).json({ error: 'DNI ya existe' }); throw err; }
});

app.put('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });
  const { nombre, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones, horas_pendientes_confirmar } = req.body;
  queries.updateTrabajadora.run({ id: req.params.id, nombre: nombre ?? prev.nombre, telefono: telefono ?? prev.telefono, horas_dia: horas_dia != null ? parseFloat(horas_dia) : prev.horas_dia, dias_mes: dias_mes != null ? parseInt(dias_mes) : prev.dias_mes, tipo_jornada: tipo_jornada ?? prev.tipo_jornada, estado: estado ?? prev.estado, observaciones: observaciones ?? prev.observaciones, pendiente: horas_pendientes_confirmar != null ? (horas_pendientes_confirmar ? 1 : 0) : prev.horas_pendientes_confirmar });
  queries.insertAudit.run(req.user.username, 'MODIFICACION_TRABAJADORA', 'trabajadoras', req.params.id, JSON.stringify(prev), JSON.stringify(req.body));
  res.json({ mensaje: 'Actualizado' });
});

app.delete('/api/admin/trabajadoras/:id', authAdmin, (req, res) => {
  const prev = queries.getTrabajadoraById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrada' });
  queries.deactivateTrabajadora.run(req.params.id);
  queries.insertAudit.run(req.user.username, 'BAJA_TRABAJADORA', 'trabajadoras', req.params.id, JSON.stringify(prev), null);
  res.json({ mensaje: 'Baja registrada' });
});

app.get('/api/admin/fichajes', authAdmin, (req, res) => {
  const { empresa_id, trabajadora_id, fecha_inicio, fecha_fin } = req.query;
  res.json(queries.getHistorialRango.all({ empresa_id: empresa_id ? parseInt(empresa_id) : null, trabajadora_id: trabajadora_id ? parseInt(trabajadora_id) : null, fecha_inicio: fecha_inicio || null, fecha_fin: fecha_fin || null }));
});

app.put('/api/admin/fichajes/:id', authAdmin, (req, res) => {
  const prev = queries.getFichajeById.get(req.params.id);
  if (!prev) return res.status(404).json({ error: 'No encontrado' });
  const { hora_entrada, hora_salida, observaciones, razon } = req.body;
  if (!razon || razon.trim().length < 5) return res.status(400).json({ error: 'Motivo obligatorio (mín. 5 caracteres)' });
  const entradaFinal = hora_entrada ?? prev.hora_entrada;
  const salidaFinal = hora_salida ?? prev.hora_salida;
  const horas = (entradaFinal && salidaFinal) ? calcularHorasTrabajadas(entradaFinal, salidaFinal) : prev.horas_trabajadas;
  queries.updateFichaje.run({ id: req.params.id, hora_entrada: entradaFinal, hora_salida: salidaFinal, horas_trabajadas: horas, observaciones: observaciones ?? prev.observaciones, admin: req.user.username, razon: razon.trim() });
  queries.insertAudit.run(req.user.username, 'CORRECCION_FICHAJE', 'fichajes', req.params.id, JSON.stringify(prev), JSON.stringify(req.body));
  res.json({ mensaje: 'Fichaje corregido' });
});

app.get('/api/admin/informe-pdf/:trabajadora_id/:anio/:mes', authAdmin, (req, res) => {
  const { trabajadora_id, anio, mes } = req.params;
  const periodo = `${anio}-${String(mes).padStart(2, '0')}`;
  const fichajes = queries.getInformeMensual.all(trabajadora_id, periodo);
  if (!fichajes.length) return res.status(404).json({ error: 'Sin registros' });
  const info = fichajes[0];
  const mesNombre = new Date(`${periodo}-01`).toLocaleDateString('es-ES', { month: 'long', year: 'numeric' });
  const doc = new PDFDoc({ margin: 40, size: 'A4' });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="registro_jornada_${info.dni}_${periodo}.pdf"`);
  doc.pipe(res);
  doc.fontSize(14).font('Helvetica-Bold').text('REGISTRO DE JORNADA', { align: 'center' });
  doc.fontSize(9).font('Helvetica').text('(Art. 34.9 ET — RD-ley 8/2019)', { align: 'center' });
  doc.moveDown(0.5); doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.3);
  const c = 40;
  doc.fontSize(9).font('Helvetica-Bold').text('EMPRESA:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.empresa_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('NIF/CIF:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.empresa_nif}`);
  doc.fontSize(9).font('Helvetica-Bold').text('CCC:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.ccc}`);
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica-Bold').text('TRABAJADORA/OR:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.trabajadora_nombre}`);
  doc.fontSize(9).font('Helvetica-Bold').text('DNI/NIE:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.dni}`);
  doc.fontSize(9).font('Helvetica-Bold').text('TIPO JORNADA:', c, doc.y, { continued: true }).font('Helvetica').text(` ${info.tipo_jornada === 'completa' ? 'Tiempo completo' : 'Tiempo parcial'}`);
  doc.fontSize(9).font('Helvetica-Bold').text('PERÍODO:', c, doc.y, { continued: true }).font('Helvetica').text(` ${mesNombre.charAt(0).toUpperCase() + mesNombre.slice(1)}`);
  doc.moveDown(0.5); doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.3);
  const colX = [40, 110, 185, 260, 320], colW = [70, 75, 75, 60, 225];
  doc.fontSize(8).font('Helvetica-Bold');
  ['FECHA','ENTRADA','SALIDA','HORAS','OBSERVACIONES'].forEach((h, i) => doc.text(h, colX[i], doc.y, { width: colW[i] }));
  doc.moveDown(0.2); doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.1);
  let totalHoras = 0, diasTrabajados = 0;
  doc.font('Helvetica').fontSize(8);
  fichajes.forEach(f => {
    const y = doc.y;
    const fechaStr = new Date(f.fecha + 'T12:00:00').toLocaleDateString('es-ES', { weekday: 'short', day: '2-digit', month: '2-digit', year: 'numeric' });
    let horasStr = '';
    if (f.horas_trabajadas != null) { horasStr = decimalToHHMM(f.horas_trabajadas); totalHoras += f.horas_trabajadas; diasTrabajados++; }
    const obs = [f.cerrado_automaticamente ? 'Auto.' : '', f.observaciones || '', f.modificado_por ? `Corr: ${f.razon_modificacion || ''}` : ''].filter(Boolean).join('; ');
    doc.text(fechaStr, colX[0], y, { width: colW[0] }); doc.text(horaDisplay(f.hora_entrada), colX[1], y, { width: colW[1] }); doc.text(horaDisplay(f.hora_salida), colX[2], y, { width: colW[2] }); doc.text(horasStr, colX[3], y, { width: colW[3] }); doc.text(obs, colX[4], y, { width: colW[4] });
    doc.moveDown(0.15); if (doc.y > 750) doc.addPage();
  });
  doc.moveDown(0.3); doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Bold').text(`Días trabajados: ${diasTrabajados}`, c);
  doc.text(`TOTAL HORAS MES: ${decimalToHHMM(totalHoras)} (${Math.round(totalHoras * 100) / 100}h)`, c);
  doc.moveDown(1); doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke(); doc.moveDown(0.3);
  doc.fontSize(7).font('Helvetica').text('Registro generado por Webgest. Conservación mínima 4 años (art. 34.9 ET).', { align: 'justify' });
  doc.moveDown(2); doc.fontSize(8).text('Firma empresa:', 40).text('Firma trabajadora/or:', 300);
  doc.end();
});

app.get('/api/admin/audit', authAdmin, (req, res) => res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all()));

cron.schedule('* * * * *', () => {
  const ahora = new Date();
  queries.getFichajesAbiertos.all().forEach(f => {
    const fin = calcularHoraFin(f.hora_entrada, f.horas_dia);
    if (ahora >= fin) {
      const salidaISO = fin.toISOString().replace('T', ' ').slice(0, 19);
      queries.closeFichaje.run(salidaISO, calcularHorasTrabajadas(f.hora_entrada, salidaISO), 1, f.id);
      console.log(`[CRON] Cierre auto: ${f.trabajadora_nombre}`);
      smsFin(f.telefono, fin);
    }
  });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.listen(PORT, '0.0.0.0', () => console.log(`✅ Control Horario Webgest en http://0.0.0.0:${PORT}`));
