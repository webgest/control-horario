'use strict';

const Database = require('better-sqlite3');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
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
    id INTEGER PRIMARY KEY AUTOINCREMENT, nombre TEXT NOT NULL, nif TEXT NOT NULL, ccc TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS trabajadoras (
    id INTEGER PRIMARY KEY AUTOINCREMENT, empresa_id INTEGER NOT NULL, nombre TEXT NOT NULL, dni TEXT UNIQUE NOT NULL, pin TEXT NOT NULL,
    telefono TEXT, horas_dia REAL NOT NULL, dias_mes INTEGER DEFAULT 30, tipo_jornada TEXT DEFAULT 'completa', estado TEXT DEFAULT 'activa',
    observaciones TEXT, horas_pendientes_confirmar INTEGER DEFAULT 0, activa INTEGER DEFAULT 1, token_acceso TEXT UNIQUE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (empresa_id) REFERENCES empresas(id)
  );
  CREATE TABLE IF NOT EXISTS fichajes (
    id INTEGER PRIMARY KEY AUTOINCREMENT, trabajadora_id INTEGER NOT NULL, fecha DATE NOT NULL, hora_entrada DATETIME NOT NULL,
    hora_salida DATETIME, horas_trabajadas REAL, cerrado_automaticamente INTEGER DEFAULT 0, observaciones TEXT,
    modificado_por TEXT, modificado_en DATETIME, razon_modificacion TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (trabajadora_id) REFERENCES trabajadoras(id)
  );
  CREATE TABLE IF NOT EXISTS admin_users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, username TEXT UNIQUE NOT NULL, password TEXT NOT NULL, nombre TEXT NOT NULL, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, admin_username TEXT NOT NULL, accion TEXT NOT NULL, tabla TEXT, registro_id INTEGER,
    datos_anteriores TEXT, datos_nuevos TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS pausas (
    id INTEGER PRIMARY KEY AUTOINCREMENT, fichaje_id INTEGER NOT NULL, inicio DATETIME NOT NULL, fin DATETIME,
    FOREIGN KEY (fichaje_id) REFERENCES fichajes(id)
  );
  CREATE INDEX IF NOT EXISTS idx_fichajes_trabajadora_fecha ON fichajes(trabajadora_id, fecha);
  CREATE INDEX IF NOT EXISTS idx_trabajadoras_dni ON trabajadoras(dni);
  CREATE INDEX IF NOT EXISTS idx_pausas_fichaje ON pausas(fichaje_id);
`);

try { db.exec('ALTER TABLE trabajadoras ADD COLUMN token_acceso TEXT'); } catch(e) {}

function generateWorkerToken() { return crypto.randomBytes(5).toString('hex'); }
function defaultPin(dni) { const d=dni.replace(/[^0-9]/g,''); return d.length>=4?d.slice(-4):'1234'; }

function seedData() {
  const n = db.prepare('SELECT COUNT(*) as n FROM empresas').get().n;
  if (n > 0) {
    const sinToken = db.prepare("SELECT id FROM trabajadoras WHERE token_acceso IS NULL AND activa=1").all();
    const upd = db.prepare('UPDATE trabajadoras SET token_acceso=? WHERE id=?');
    sinToken.forEach(t => upd.run(generateWorkerToken(), t.id));
    return;
  }
  console.log('Inicializando datos...');
  const adminPass = bcrypt.hashSync(process.env.ADMIN_PASSWORD||'Webgest2026!', 10);
  db.prepare('INSERT OR IGNORE INTO admin_users (username,password,nombre) VALUES (?,?,?)').run(process.env.ADMIN_USERNAME||'webgest', adminPass, 'Administrador Webgest');
  const ie = db.prepare('INSERT INTO empresas (nombre,nif,ccc) VALUES (?,?,?)');
  const it = db.prepare('INSERT INTO trabajadoras (empresa_id,nombre,dni,pin,telefono,horas_dia,dias_mes,tipo_jornada,estado,observaciones,horas_pendientes_confirmar,token_acceso) VALUES (@eid,@nombre,@dni,@pin,null,@hd,@dm,@tj,@es,@obs,@p,@tok)');
  function aw(eid,nombre,dni,hd,dm,tj,es,obs,p){it.run({eid,nombre,dni,pin:bcrypt.hashSync(defaultPin(dni),10),hd,dm,tj:tj||'completa',es:es||'activa',obs:obs||null,p:p?1:0,tok:generateWorkerToken()});}
  const H=HORAS_COMPLETA;
  const e1=ie.run('CONTRATACIONES LIMPIMUR, S.L.','B30381230','30/1009098-56').lastInsertRowid;
  aw(e1,'Miñarro García, Isabel Pilar','23233727R',H,30,'parcial','IT','ILT pendiente confirmar.',true);
  aw(e1,'Monteagudo Pujalte, María Carmen','27476364N',H,31,'completa','activa',null,false);
  aw(e1,'Navarro Rodríguez, Francisca','23226904D',4.84,30,'parcial','activa','Base 734,70€ pendiente confirmar.',true);
  aw(e1,'Palomeque Pérez, Vanessa Mabel','60246144J',4.21,30,'parcial','activa','Base 639,17€ pendiente confirmar.',true);
  aw(e1,'Sánchez Jiménez, Juana María','23280620C',7.27,30,'parcial','activa','Base 1.103,71€ pendiente confirmar.',true);
  const e2=ie.run('GRUPO LIMPIMUR EXPANSIÓN, S.L.','B73579872','30/1184917-14').lastInsertRowid;
  aw(e2,'García Carrillo, Dolores','23237143J',H,30,'completa','activa',null,false);
  aw(e2,'Moya Vas, María Agustina','23260032V',H,30,'completa','activa',null,false);
  aw(e2,'Vargas Aguilera, José','23249444D',4.95,30,'parcial','activa','Base 752,13€ pendiente confirmar.',true);
  const e3=ie.run('CAMPICO BLANCO SCOOP','F73863276','30126518563').lastInsertRowid;
  aw(e3,'Cardoso Riverol, Himilce Caridad','30296065M',H,30,'completa','activa',null,false);
  aw(e3,'Cedillo Abrigo, Lady Jovanna','60391608W',H,30,'completa','activa',null,false);
  aw(e3,'Celdrán Garrigós, Concepción','34800714N',5.99,21,'parcial','activa',null,false);
  aw(e3,'Fernández Campoy, Mercedes','23251913V',4.00,21,'parcial','activa',null,false);
  aw(e3,'Fernández López, Isabel','23247227T',H,30,'completa','activa',null,false);
  aw(e3,'Fernández López, Miguel','23247228R',H,30,'completa','activa',null,false);
  aw(e3,'González Venteo, María José','17469048L',4.00,20,'parcial','activa','Alta 12/05/2026.',false);
  aw(e3,'Leines Muquinche, Wilson Arturo','24462214N',H,30,'completa','activa',null,false);
  aw(e3,'López Beltrán, Caridad Rosario','23251554A',H,30,'completa','activa',null,false);
  aw(e3,'López Molina, Ángeles','23273704G',5.99,21,'parcial','activa',null,false);
  aw(e3,'López Molina, María','23273705M',H,30,'completa','activa',null,false);
  aw(e3,'Lozoya Alcázar, Juana','23245046G',H,30,'completa','activa',null,false);
  aw(e3,'Martínez Mora, Agustina','23233737B',H,30,'completa','activa',null,false);
  aw(e3,'Poveda Hernández, Rosario','23233171C',H,30,'completa','activa',null,false);
  aw(e3,'Quiñonero Pérez, María Luz','23293489D',5.00,20,'parcial','activa','IT parcial mayo 2026.',false);
  aw(e3,'Romero Celdrán, Andrea','49854509P',5.99,21,'parcial','activa',null,false);
  aw(e3,'Vásquez Cortés, María del Carmen','Y1088105N',H,30,'completa','activa',null,false);
  const e4=ie.run('GIOMUR S. COOP','F73869620','30132392117').lastInsertRowid;
  aw(e4,'Abellán Romera, Concepción','23224638C',H,30,'completa','activa',null,false);
  aw(e4,'Bonillo Caballero, Juana María','23276570H',H,30,'completa','activa',null,false);
  aw(e4,'Cardeño Hurtado, Diana Cristina','Y0630036B',H,30,'completa','activa',null,false);
  aw(e4,'Jouilik El Habbarri, Najat','23833818E',H,30,'completa','activa',null,false);
  aw(e4,'López Jódar, Catalina Ángel','23249849T',H,30,'completa','activa',null,false);
  aw(e4,'Manzanares Alcázar, Andrea','23288049C',H,30,'completa','activa',null,false);
  aw(e4,'Miñarro García, María Isabel','23224185G',5.99,21,'parcial','activa',null,false);
  aw(e4,'Pérez Estrada, Vilma Araceli','13381919J',H,30,'completa','activa',null,false);
  aw(e4,'Pérez Jordán, María Carmen','23229357R',H,30,'completa','activa',null,false);
  aw(e4,'Pérez Pérez, María','23239758Y',H,30,'completa','activa',null,false);
  aw(e4,'Reinaldos López, Ascensión','23227468K',H,30,'completa','IT','IT completa mayo 2026.',false);
  aw(e4,'Salinas Macas, Lady Tamara','30296461X',5.99,21,'parcial','activa',null,false);
  aw(e4,'Vera Ruiz, María Isabel','23252196R',3.99,4,'parcial','baja','Baja desde 04/05/2026.',false);
  const e5=ie.run('SGN AYUDA A DOMICILIO S. COOP','F05546171','30132391612').lastInsertRowid;
  aw(e5,'Giner Ayén, Josefa','23245307N',H,30,'completa','activa',null,false);
  aw(e5,'Jódar Bravo, Francisca','23258691X',H,30,'completa','activa',null,false);
  aw(e5,'Periago Montero, María Huertas','23255645T',4.00,21,'parcial','activa',null,false);
  aw(e5,'Sánchez Alonso, María Carmen','23255753Q',5.99,21,'parcial','activa',null,false);
  aw(e5,'Sánchez Giménez, Carmen','23291722J',6.00,21,'parcial','activa',null,false);
  console.log('Datos iniciales cargados.');
}
seedData();

const queries = {
  getWorkerByDni: db.prepare('SELECT t.*,e.nombre AS empresa_nombre FROM trabajadoras t JOIN empresas e ON t.empresa_id=e.id WHERE t.dni=? AND t.activa=1'),
  getTrabajadoraByToken: db.prepare('SELECT t.*,e.nombre AS empresa_nombre FROM trabajadoras t JOIN empresas e ON t.empresa_id=e.id WHERE t.token_acceso=? AND t.activa=1'),
  getAdminByUsername: db.prepare('SELECT * FROM admin_users WHERE username=?'),
  getFichajeHoyByTrabajadora: db.prepare("SELECT * FROM fichajes WHERE trabajadora_id=? AND fecha=date('now','localtime') ORDER BY id DESC LIMIT 1"),
  getFichajeAbierto: db.prepare("SELECT f.*,t.nombre AS trabajadora_nombre,t.horas_dia,t.telefono,e.nombre AS empresa_nombre FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id=t.id JOIN empresas e ON t.empresa_id=e.id WHERE f.trabajadora_id=? AND f.hora_salida IS NULL ORDER BY f.id DESC LIMIT 1"),
  createFichaje: db.prepare("INSERT INTO fichajes (trabajadora_id,fecha,hora_entrada) VALUES (?,date('now','localtime'),datetime('now','localtime'))"),
  closeFichaje: db.prepare('UPDATE fichajes SET hora_salida=?,horas_trabajadas=?,cerrado_automaticamente=? WHERE id=?'),
  getHistorialMes: db.prepare("SELECT f.*,round((julianday(COALESCE(f.hora_salida,datetime('now','localtime')))-julianday(f.hora_entrada))*24,2) AS horas_calc FROM fichajes f WHERE f.trabajadora_id=? AND strftime('%Y-%m',f.fecha)=strftime('%Y-%m','now','localtime') ORDER BY f.fecha DESC"),
  getHistorialRango: db.prepare("SELECT f.*,t.nombre AS trabajadora_nombre,t.dni,e.nombre AS empresa_nombre,e.id AS empresa_id FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id=t.id JOIN empresas e ON t.empresa_id=e.id WHERE (@empresa_id IS NULL OR e.id=@empresa_id) AND (@trabajadora_id IS NULL OR f.trabajadora_id=@trabajadora_id) AND (@fecha_inicio IS NULL OR f.fecha>=@fecha_inicio) AND (@fecha_fin IS NULL OR f.fecha<=@fecha_fin) ORDER BY e.nombre,t.nombre,f.fecha DESC LIMIT 500"),
  getAllTrabajadoras: db.prepare("SELECT t.*,e.nombre AS empresa_nombre,e.nif AS empresa_nif FROM trabajadoras t JOIN empresas e ON t.empresa_id=e.id WHERE t.activa=1 ORDER BY e.nombre,t.nombre"),
  getTrabajadorasByEmpresa: db.prepare('SELECT * FROM trabajadoras WHERE empresa_id=? AND activa=1 ORDER BY nombre'),
  getTrabajadoraById: db.prepare('SELECT t.*,e.nombre AS empresa_nombre FROM trabajadoras t JOIN empresas e ON t.empresa_id=e.id WHERE t.id=?'),
  updateTrabajadora: db.prepare('UPDATE trabajadoras SET nombre=@nombre,telefono=@telefono,horas_dia=@horas_dia,dias_mes=@dias_mes,tipo_jornada=@tipo_jornada,estado=@estado,observaciones=@observaciones,horas_pendientes_confirmar=@pendiente WHERE id=@id'),
  insertTrabajadora: db.prepare('INSERT INTO trabajadoras (empresa_id,nombre,dni,pin,telefono,horas_dia,dias_mes,tipo_jornada,estado,observaciones,token_acceso) VALUES (@empresa_id,@nombre,@dni,@pin,@telefono,@horas_dia,@dias_mes,@tipo_jornada,@estado,@observaciones,@tok)'),
  deactivateTrabajadora: db.prepare("UPDATE trabajadoras SET activa=0,estado='baja' WHERE id=?"),
  updatePin: db.prepare('UPDATE trabajadoras SET pin=? WHERE id=?'),
  updateToken: db.prepare('UPDATE trabajadoras SET token_acceso=? WHERE id=?'),
  getAllEmpresas: db.prepare('SELECT * FROM empresas ORDER BY nombre'),
  getEstadoHoyByEmpresa: db.prepare("SELECT t.id,t.nombre,t.dni,t.estado,t.horas_dia,t.tipo_jornada,t.horas_pendientes_confirmar,f.id AS fichaje_id,f.hora_entrada,f.hora_salida,f.horas_trabajadas,f.observaciones AS fichaje_obs FROM trabajadoras t LEFT JOIN fichajes f ON f.trabajadora_id=t.id AND f.fecha=date('now','localtime') WHERE t.empresa_id=? AND t.activa=1 ORDER BY t.nombre"),
  getFichajesAbiertos: db.prepare("SELECT f.id,f.trabajadora_id,f.hora_entrada,t.horas_dia,t.nombre AS trabajadora_nombre,t.telefono,e.nombre AS empresa_nombre FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id=t.id JOIN empresas e ON t.empresa_id=e.id WHERE f.hora_salida IS NULL"),
  updateFichaje: db.prepare("UPDATE fichajes SET hora_entrada=@hora_entrada,hora_salida=@hora_salida,horas_trabajadas=@horas_trabajadas,observaciones=@observaciones,modificado_por=@admin,modificado_en=datetime('now','localtime'),razon_modificacion=@razon WHERE id=@id"),
  getFichajeById: db.prepare('SELECT * FROM fichajes WHERE id=?'),
  insertAudit: db.prepare('INSERT INTO audit_log (admin_username,accion,tabla,registro_id,datos_anteriores,datos_nuevos) VALUES (?,?,?,?,?,?)'),
  getAuditLog: db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200'),
  insertEmpresa: db.prepare('INSERT INTO empresas (nombre,nif,ccc) VALUES (?,?,?)'),
  getPausaActiva:  db.prepare("SELECT * FROM pausas WHERE fichaje_id=? AND fin IS NULL ORDER BY id DESC LIMIT 1"),
  getPausas:       db.prepare("SELECT * FROM pausas WHERE fichaje_id=? ORDER BY inicio ASC"),
  insertPausa:     db.prepare("INSERT INTO pausas (fichaje_id,inicio) VALUES (?,datetime('now','localtime'))"),
  cerrarPausa:     db.prepare("UPDATE pausas SET fin=datetime('now','localtime') WHERE fichaje_id=? AND fin IS NULL"),
  getTotalPausasH: db.prepare("SELECT COALESCE(SUM((julianday(COALESCE(fin,datetime('now','localtime')))-julianday(inicio))*24),0) AS total FROM pausas WHERE fichaje_id=?"),
  getInformeMensual: db.prepare("SELECT f.fecha,f.hora_entrada,f.hora_salida,f.horas_trabajadas,f.cerrado_automaticamente,f.observaciones,f.modificado_por,f.razon_modificacion,t.nombre AS trabajadora_nombre,t.dni,t.tipo_jornada,t.horas_dia,e.nombre AS empresa_nombre,e.nif AS empresa_nif,e.ccc FROM fichajes f JOIN trabajadoras t ON f.trabajadora_id=t.id JOIN empresas e ON t.empresa_id=e.id WHERE f.trabajadora_id=? AND strftime('%Y-%m',f.fecha)=? ORDER BY f.fecha ASC"),
};

function decimalToHHMM(h){const ho=Math.floor(h),mi=Math.round((h-ho)*60);return ho+':'+String(mi).padStart(2,'0');}
function calcularHoraFin(e,h){return new Date(new Date(e).getTime()+Math.round(h*3600)*1000);}
function calcularHorasTrabajadas(e,s){return Math.round(((new Date(s)-new Date(e))/3600000)*100)/100;}
function horaDisplay(s){if(!s)return'—';return String(s).slice(11,16);}
module.exports={db,queries,decimalToHHMM,calcularHoraFin,calcularHorasTrabajadas,horaDisplay,generateWorkerToken};