'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || './data/control_horario.db';
const HORAS_COMPLETA = parseFloat(process.env.HORAS_JORNADA_COMPLETA || '8.30');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS empresas (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    nombre   TEXT NOT NULL,
    nif      TEXT NOT NULL,
    ccc      TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS trabajadoras (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    empresa_id                INTEGER NOT NULL,
    nombre                    TEXT NOT NULL,
    dni                       TEXT UNIQUE NOT NULL,
    pin                       TEXT NOT NULL,
    telefono                  TEXT,
    horas_dia                 REAL NOT NULL,
    dias_mes                  INTEGER DEFAULT 30,
    tipo_jornada              TEXT DEFAULT 'completa',
    estado                    TEXT DEFAULT 'activa',
    observaciones             TEXT,
    horas_pendientes_confirmar INTEGER DEFAULT 0,
    activa                    INTEGER DEFAULT 1,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  );

  CREATE TABLE IF NOT EXISTS fichajes (
    id                        INTEGER PRIMARY KEY AUTOINCREMENT,
    trabajadora_id            INTEGER NOT NULL,
    fecha                     DATE NOT NULL,
    hora_entrada              DATETIME NOT NULL,
    hora_salida               DATETIME,
    horas_trabajadas          REAL,
    cerrado_automaticamente   INTEGER DEFAULT 0,
    observaciones             TEXT,
    modificado_por            TEXT,
    modificado_en             DATETIME,
    razon_modificacion        TEXT,
    created_at                DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (trabajadora_id) REFERENCES trabajadoras(id)
  );

  CREATE TABLE IF NOT EXISTS admin_users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    username   TEXT UNIQUE NOT NULL,
    password   TEXT NOT NULL,
    nombre     TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    admin_username   TEXT NOT NULL,
    accion           TEXT NOT NULL,
    tabla            TEXT,
    registro_id      INTEGER,
    datos_anteriores TEXT,
    datos_nuevos     TEXT,
    created_at       DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_fichajes_trabajadora_fecha ON fichajes(trabajadora_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_trabajadoras_dni ON trabajadoras(dni);
`);

function defaultPin(dni) {
  const digits = dni.replace(/[^0-9]/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '1234';
}

function seedData() {
  const countEmpresas = db.prepare('SELECT COUNT(*) as n FROM empresas').get().n;
  if (countEmpresas > 0) return;

  console.log('Inicializando datos iniciales...');

  const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD || 'Webgest2026!', 10);
  db.prepare('INSERT OR IGNORE INTO admin_users (username, password, nombre) VALUES (?, ?, ?)')
    .run(process.env.ADMIN_USERNAME || 'webgest', adminPass, 'Administrador Webgest');

  const insertEmpresa = db.prepare('INSERT INTO empresas (nombre, nif, ccc) VALUES (?, ?, ?)');
  const insertTrabajadora = db.prepare(`
    INSERT INTO trabajadoras (empresa_id, nombre, dni, pin, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones, horas_pendientes_confirmar)
    VALUES (@empresa_id, @nombre, @dni, @pin, @telefono, @horas_dia, @dias_mes, @tipo_jornada, @estado, @observaciones, @pendiente)
  `);

  function addWorker(empresaId, nombre, dni, horasDia, diasMes, tipoJornada, estado, observaciones, pendiente) {
    insertTrabajadora.run({
      empresa_id: empresaId, nombre, dni,
      pin: bcrypt.hashSync(defaultPin(dni), 10),
      telefono: null, horas_dia: horasDia, dias_mes: diasMes,
      tipo_jornada: tipoJornada || 'completa',
      estado: estado || 'activa',
      observaciones: observaciones || null,
      pendiente: pendiente ? 1 : 0,
    });
  }

  const H = HORAS_COMPLETA;

  const e1 = insertEmpresa.run('CONTRATACIONES LIMPIMUR, S.L.', 'B30381230', '30/1009098-56').lastInsertRowid;
  addWorker(e1, 'Minarro Garcia, Isabel Pilar', '23233727R', H, 30, 'parcial', 'IT', 'ILT - En incapacidad temporal.', true);
  addWorker(e1, 'Monteagudo Pujalte, Maria Carmen', '27476364N', H, 31, 'completa', 'activa', null, false);
  addWorker(e1, 'Navarro Rodriguez, Francisca', '23226904D', 4.84, 30, 'parcial', 'activa', 'Parcial base 734,70. Horas estimadas.', true);
  addWorker(e1, 'Palomeque Perez, Vanessa Mabel', '60246144J', 4.21, 30, 'parcial', 'activa', 'Parcial base 639,17. Horas estimadas.', true);
  addWorker(e1, 'Sanchez Jimenez, Juana Maria', '23280620C', 7.27, 30, 'parcial', 'activa', 'Parcial base 1103,71. Horas estimadas.', true);

  const e2 = insertEmpresa.run('GRUPO LIMPIMUR EXPANSION, S.L.', 'B73579872', '30/1184917-14').lastInsertRowid;
  addWorker(e2, 'Garcia Carrillo, Dolores', '23237143J', H, 30, 'completa', 'activa', null, false);
  addWorker(e2, 'Moya Vas, Maria Agustina', '23260032V', H, 30, 'completa', 'activa', null, false);
  addWorker(e2, 'Vargas Aguilera, Jose', '23249444D', 4.95, 30, 'parcial', 'activa', 'Parcial base 752,13. Horas estimadas.', true);

  const e3 = insertEmpresa.run('CAMPICO BLANCO SCOOP', 'F73863276', '30126518563').lastInsertRowid;
  addWorker(e3, 'Cardoso Riverol, Himilce Caridad', '30296065M', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Cedillo Abrigo, Lady Jovanna', '60391608W', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Celdran Garrigos, Concepcion', '34800714N', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e3, 'Fernandez Campoy, Mercedes', '23251913V', 4.00, 21, 'parcial', 'activa', null, false);
  addWorker(e3, 'Fernandez Lopez, Isabel', '23247227T', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Fernandez Lopez, Miguel', '23247228R', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Gonzalez Venteo, Maria Jose', '17469048L', 4.00, 20, 'parcial', 'activa', 'Alta 12/05/2026.', false);
  addWorker(e3, 'Leines Muquinche, Wilson Arturo', '24462214N', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Lopez Beltran, Caridad Rosario', '23251554A', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Lopez Molina, Angeles', '23273704G', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e3, 'Lopez Molina, Maria', '23273705M', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Lozoya Alcazar, Juana', '23245046G', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Martinez Mora, Agustina', '23233737B', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Poveda Hernandez, Rosario', '23233171C', H, 30, 'completa', 'activa', null, false);
  addWorker(e3, 'Quinonero Perez, Maria Luz', '23293489D', 5.00, 20, 'parcial', 'activa', 'IT parcial mayo 2026.', false);
  addWorker(e3, 'Romero Celdran, Andrea', '49854509P', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e3, 'Vasquez Cortes, Maria del Carmen', 'Y1088105N', H, 30, 'completa', 'activa', null, false);

  const e4 = insertEmpresa.run('GIOMUR S. COOP', 'F73869620', '30132392117').lastInsertRowid;
  addWorker(e4, 'Abellan Romera, Concepcion', '23224638C', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Bonillo Caballero, Juana Maria', '23276570H', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Cardeno Hurtado, Diana Cristina', 'Y0630036B', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Jouilik El Habbarri, Najat', '23833818E', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Lopez Jodar, Catalina Angel', '23249849T', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Manzanares Alcazar, Andrea', '23288049C', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Minarro Garcia, Maria Isabel', '23224185G', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e4, 'Perez Estrada, Vilma Araceli', '13381919J', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Perez Jordan, Maria Carmen', '23229357R', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Perez Perez, Maria', '23239758Y', H, 30, 'completa', 'activa', null, false);
  addWorker(e4, 'Reinaldos Lopez, Ascension', '23227468K', H, 30, 'completa', 'IT', 'IT completa mayo 2026.', false);
  addWorker(e4, 'Salinas Macas, Lady Tamara', '30296461X', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e4, 'Vera Ruiz, Maria Isabel', '23252196R', 3.99, 4, 'parcial', 'baja', 'Baja desde 04/05/2026.', false);

  const e5 = insertEmpresa.run('SGN AYUDA A DOMICILIO S. COOP', 'F05546171', '30132391612').lastInsertRowid;
  addWorker(e5, 'Giner Ayen, Josefa', '23245307N', H, 30, 'completa', 'activa', null, false);
  addWorker(e5, 'Jodar Bravo, Francisca', '23258691X', H, 30, 'completa', 'activa', null, false);
  addWorker(e5, 'Periago Montero, Maria Huertas', '23255645T', 4.00, 21, 'parcial', 'activa', null, false);
  addWorker(e5, 'Sanchez Alonso, Maria Carmen', '23255753Q', 5.99, 21, 'parcial', 'activa', null, false);
  addWorker(e5, 'Sanchez Gimenez, Carmen', '23291722J', 6.00, 21, 'parcial', 'activa', null, false);

  console.log('Datos iniciales cargados.');
}

seedData();

const queries = {
  getWorkerByDni: db.prepare('SELECT t.*, e.nombre AS empresa_nombre FROM trabajadoras t JOIN empresas e ON t.empresa_id = e.id WHERE t.dni = ? AND t.activa = 1'),
  getAdminByUsername: db.prepare('SELECT * FROM admin_users WHERE username = ?'),
  getFichajeHoyByTrabajadora: db.prepare("SELECT * FROM fichajes WHERE trabajadora_id = ? AND fecha = date('now', 'localtime') ORDER BY id DESC LIMIT 1"),
  getFichajeAbierto: db.prepare("SELECT f.*, t.nombre AS trabajadora_nombre, t.horas_dia, t.telefono, e.nombre AS empresa_nombre FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id = t.id JOIN empresas e ON t.empresa_id = e.id WHERE f.trabajadora_id = ? AND f.hora_salida IS NULL ORDER BY f.id DESC LIMIT 1"),
  createFichaje: db.prepare("INSERT INTO fichajes (trabajadora_id, fecha, hora_entrada) VALUES (?, date('now', 'localtime'), datetime('now', 'localtime'))"),
  closeFichaje: db.prepare('UPDATE fichajes SET hora_salida = ?, horas_trabajadas = ?, cerrado_automaticamente = ? WHERE id = ?'),
  getHistorialMes: db.prepare("SELECT f.*, round((julianday(COALESCE(f.hora_salida, datetime('now','localtime'))) - julianday(f.hora_entrada)) * 24, 2) AS horas_calc FROM fichajes f WHERE f.trabajadora_id = ? AND strftime('%Y-%m', f.fecha) = strftime('%Y-%m', 'now', 'localtime') ORDER BY f.fecha DESC"),
  getHistorialRango: db.prepare("SELECT f.*, t.nombre AS trabajadora_nombre, t.dni, e.nombre AS empresa_nombre, e.id AS empresa_id FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id = t.id JOIN empresas e ON t.empresa_id = e.id WHERE (@empresa_id IS NULL OR e.id = @empresa_id) AND (@trabajadora_id IS NULL OR f.trabajadora_id = @trabajadora_id) AND (@fecha_inicio IS NULL OR f.fecha >= @fecha_inicio) AND (@fecha_fin IS NULL OR f.fecha <= @fecha_fin) ORDER BY e.nombre, t.nombre, f.fecha DESC LIMIT 500"),
  getAllTrabajadoras: db.prepare("SELECT t.*, e.nombre AS empresa_nombre, e.nif AS empresa_nif FROM trabajadoras t JOIN empresas e ON t.empresa_id = e.id WHERE t.activa = 1 ORDER BY e.nombre, t.nombre"),
  getTrabajadorasByEmpresa: db.prepare('SELECT * FROM trabajadoras WHERE empresa_id = ? AND activa = 1 ORDER BY nombre'),
  getTrabajadoraById: db.prepare('SELECT t.*, e.nombre AS empresa_nombre FROM trabajadoras t JOIN empresas e ON t.empresa_id = e.id WHERE t.id = ?'),
  updateTrabajadora: db.prepare('UPDATE trabajadoras SET nombre = @nombre, telefono = @telefono, horas_dia = @horas_dia, dias_mes = @dias_mes, tipo_jornada = @tipo_jornada, estado = @estado, observaciones = @observaciones, horas_pendientes_confirmar = @pendiente WHERE id = @id'),
  insertTrabajadora: db.prepare('INSERT INTO trabajadoras (empresa_id, nombre, dni, pin, telefono, horas_dia, dias_mes, tipo_jornada, estado, observaciones) VALUES (@empresa_id, @nombre, @dni, @pin, @telefono, @horas_dia, @dias_mes, @tipo_jornada, @estado, @observaciones)'),
  deactivateTrabajadora: db.prepare("UPDATE trabajadoras SET activa = 0, estado = 'baja' WHERE id = ?"),
  updatePin: db.prepare('UPDATE trabajadoras SET pin = ? WHERE id = ?'),
  getAllEmpresas: db.prepare('SELECT * FROM empresas ORDER BY nombre'),
  getEstadoHoyByEmpresa: db.prepare("SELECT t.id, t.nombre, t.dni, t.estado, t.horas_dia, t.tipo_jornada, t.horas_pendientes_confirmar, f.id AS fichaje_id, f.hora_entrada, f.hora_salida, f.horas_trabajadas, f.observaciones AS fichaje_obs FROM trabajadoras t LEFT JOIN fichajes f ON f.trabajadora_id = t.id AND f.fecha = date('now', 'localtime') WHERE t.empresa_id = ? AND t.activa = 1 ORDER BY t.nombre"),
  getFichajesAbiertos: db.prepare("SELECT f.id, f.trabajadora_id, f.hora_entrada, t.horas_dia, t.nombre AS trabajadora_nombre, t.telefono, e.nombre AS empresa_nombre FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id = t.id JOIN empresas e ON t.empresa_id = e.id WHERE f.hora_salida IS NULL"),
  updateFichaje: db.prepare("UPDATE fichajes SET hora_entrada = @hora_entrada, hora_salida = @hora_salida, horas_trabajadas = @horas_trabajadas, observaciones = @observaciones, modificado_por = @admin, modificado_en = datetime('now', 'localtime'), razon_modificacion = @razon WHERE id = @id"),
  getFichajeById: db.prepare('SELECT * FROM fichajes WHERE id = ?'),
  insertAudit: db.prepare('INSERT INTO audit_log (admin_username, accion, tabla, registro_id, datos_anteriores, datos_nuevos) VALUES (?, ?, ?, ?, ?, ?)'),
  getInformeMensual: db.prepare("SELECT f.fecha, f.hora_entrada, f.hora_salida, f.horas_trabajadas, f.cerrado_automaticamente, f.observaciones, f.modificado_por, f.razon_modificacion, t.nombre AS trabajadora_nombre, t.dni, t.tipo_jornada, t.horas_dia, e.nombre AS empresa_nombre, e.nif AS empresa_nif, e.ccc FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id = t.id JOIN empresas e ON t.empresa_id = e.id WHERE f.trabajadora_id = ? AND strftime('%Y-%m', f.fecha) = ? ORDER BY f.fecha ASC"),
};

function decimalToHHMM(h) {
  const horas = Math.floor(h);
  const minutos = Math.round((h - horas) * 60);
  return horas + ':' + String(minutos).padStart(2, '0');
}

function calcularHoraFin(horaEntrada, horasDia) {
  const entrada = new Date(horaEntrada);
  return new Date(entrada.getTime() + Math.round(horasDia * 3600) * 1000);
}

function calcularHorasTrabajadas(entrada, salida) {
  return Math.round(((new Date(salida) - new Date(entrada)) / 3600000) * 100) / 100;
}

function horaDisplay(isoStr) {
  if (!isoStr) return '--';
  return String(isoStr).slice(11, 16);
}

module.exports = { db, queries, decimalToHHMM, calcularHoraFin, calcularHorasTrabajadas, horaDisplay };
