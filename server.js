'use strict';
try{require('fs').readFileSync('.env','utf8').split('\n').filter(l=>l&&!l.startsWith('#')).forEach(l=>{const[k,...v]=l.split('=');if(k&&!process.env[k.trim()])process.env[k.trim()]=v.join('=').trim();});}catch(_){}
process.env.TZ=process.env.TZ||'Europe/Madrid';
const express=require('express'),bcrypt=require('bcrypt'),jwt=require('jsonwebtoken'),cron=require('node-cron'),PDFDoc=require('pdfkit'),path=require('path');
const{db,queries,decimalToHHMM,calcularHoraFin,calcularHorasTrabajadas,horaDisplay,generateWorkerToken}=require('./database');
const{smsFin}=require('./sms');
const app=express(),PORT=parseInt(process.env.PORT||'3000'),SECRET=process.env.JWT_SECRET||'dev_secret';
app.use(express.json());app.use(express.static(path.join(__dirname,'public')));
function authW(req,res,next){const t=(req.headers.authorization||'').replace('Bearer ','');if(!t)return res.status(401).json({error:'Sin autorizacion'});try{req.user=jwt.verify(t,SECRET);if(req.user.role!=='worker')throw 0;next();}catch{res.status(401).json({error:'Token invalido'});}}
function authA(req,res,next){const t=(req.headers.authorization||'').replace('Bearer ','');if(!t)return res.status(401).json({error:'Sin autorizacion'});try{req.user=jwt.verify(t,SECRET);if(req.user.role!=='admin')throw 0;next();}catch{res.status(401).json({error:'Token invalido'});}}
function nowISO(){const n=new Date();return new Date(n-n.getTimezoneOffset()*60000).toISOString().replace('T',' ').slice(0,19);}
function todayLocal(){return nowISO().slice(0,10);}
app.get('/api/trabajadoras-publico',(req,res)=>{res.json(queries.getAllEmpresas.all().map(emp=>({id:emp.id,nombre:emp.nombre,trabajadoras:db.prepare('SELECT id,nombre,estado FROM trabajadoras WHERE empresa_id=? AND activa=1 ORDER BY nombre').all(emp.id)})));});
app.post('/api/auth/login',(req,res)=>{
  const{trabajadora_id}=req.body||{};if(!trabajadora_id)return res.status(400).json({error:'Falta id'});
  const w=queries.getTrabajadoraById.get(parseInt(trabajadora_id));if(!w||!w.activa)return res.status(404).json({error:'No encontrada'});
  const token=jwt.sign({id:w.id,role:'worker',nombre:w.nombre,empresa:w.empresa_nombre},SECRET,{expiresIn:'24h'});
  res.json({token,nombre:w.nombre,empresa:w.empresa_nombre,estado:w.estado,horas_dia:w.horas_dia});
});
app.get('/api/worker-token/:token',(req,res)=>{
  const w=queries.getTrabajadoraByToken.get(req.params.token);if(!w)return res.status(404).json({error:'Enlace no valido'});
  const token=jwt.sign({id:w.id,role:'worker',nombre:w.nombre,empresa:w.empresa_nombre},SECRET,{expiresIn:'24h'});
  res.json({token,nombre:w.nombre,empresa:w.empresa_nombre,estado:w.estado,horas_dia:w.horas_dia,tipo_jornada:w.tipo_jornada});
});
app.post('/api/auth/admin/login',async(req,res)=>{
  const{username,password}=req.body||{};if(!username||!password)return res.status(400).json({error:'Credenciales requeridas'});
  const a=queries.getAdminByUsername.get(username.trim());if(!a)return res.status(401).json({error:'Contrasena incorrecta'});
  if(!await bcrypt.compare(password,a.password))return res.status(401).json({error:'Contrasena incorrecta'});
  const token=jwt.sign({id:a.id,role:'admin',username:a.username,nombre:a.nombre},SECRET,{expiresIn:'8h'});
  res.json({token,nombre:a.nombre,username:a.username});
});
app.get('/api/fichar/estado',authW,(req,res)=>{
  const hoy=queries.getFichajeHoyByTrabajadora.get(req.user.id),w=queries.getTrabajadoraById.get(req.user.id);
  if(!hoy)return res.json({estado:'sin_fichar',fichaje:null,horas_dia:w.horas_dia});
  if(!hoy.hora_salida){const fin=calcularHoraFin(hoy.hora_entrada,w.horas_dia);return res.json({estado:'en_jornada',fichaje:hoy,hora_fin_prevista:fin.toISOString(),hora_fin_display:fin.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})});}
  return res.json({estado:'jornada_completada',fichaje:hoy});
});
app.post('/api/fichar/entrada',authW,(req,res)=>{
  const w=queries.getTrabajadoraById.get(req.user.id);if(!w)return res.status(404).json({error:'No encontrada'});
  if(w.estado==='IT'||w.estado==='baja')return res.status(403).json({error:'No puedes fichar: estas en '+w.estado});
  const hoy=queries.getFichajeHoyByTrabajadora.get(req.user.id);
  if(hoy&&hoy.hora_salida)return res.status(409).json({error:'Ya has completado tu jornada de hoy.'});
  if(hoy&&!hoy.hora_salida){const fin=calcularHoraFin(hoy.hora_entrada,w.horas_dia);return res.json({estado:'en_jornada',fichaje:hoy,hora_fin_prevista:fin.toISOString(),hora_fin_display:fin.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'}),mensaje:'Jornada ya iniciada.'});}
  const result=queries.createFichaje.run(req.user.id),fichaje=queries.getFichajeById.get(result.lastInsertRowid);
  const fin=calcularHoraFin(fichaje.hora_entrada,w.horas_dia),fd=fin.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
  res.json({estado:'en_jornada',fichaje,hora_fin_prevista:fin.toISOString(),hora_fin_display:fd,mensaje:'Jornada iniciada. Finaliza a las '+fd+'. Buena jornada!'});
});

// Pausa
app.post('/api/fichar/pausa', authWorker, function(req, res) {
  var hoy=queries.getFichajeHoyByTrabajadora.get(req.user.id);
  if(!hoy||hoy.hora_salida) return res.status(400).json({error:'No tienes jornada activa.'});
  var pausaActiva=queries.getPausaActiva.get(hoy.id);
  if(pausaActiva) return res.status(409).json({error:'Ya tienes una pausa activa. Reanuda primero.'});
  queries.insertPausa.run(hoy.id);
  var totalPausasH=queries.getTotalPausasH.get(hoy.id).total;
  var worker=queries.getTrabajadoraById.get(req.user.id);
  var fin=calcularHoraFin(hoy.hora_entrada, worker.horas_dia+totalPausasH);
  res.json({ok:true, estado:'en_pausa', mensaje:'Pausa iniciada. Pulsa REANUDAR cuando vuelvas.', fichaje:hoy, hora_fin_prevista:fin.toISOString(), hora_fin_display:fin.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'})});
});

app.post('/api/fichar/reanudar', authWorker, function(req, res) {
  var hoy=queries.getFichajeHoyByTrabajadora.get(req.user.id);
  if(!hoy||hoy.hora_salida) return res.status(400).json({error:'No tienes jornada activa.'});
  var pausaActiva=queries.getPausaActiva.get(hoy.id);
  if(!pausaActiva) return res.status(409).json({error:'No tienes ninguna pausa activa.'});
  queries.cerrarPausa.run(hoy.id);
  var totalPausasH=queries.getTotalPausasH.get(hoy.id).total;
  var worker=queries.getTrabajadoraById.get(req.user.id);
  var fin=calcularHoraFin(hoy.hora_entrada, worker.horas_dia+totalPausasH);
  var finDisplay=fin.toLocaleTimeString('es-ES',{hour:'2-digit',minute:'2-digit'});
  res.json({ok:true, estado:'en_jornada', mensaje:'Bienvenida de nuevo. Tu jornada finaliza a las '+finDisplay+'.', fichaje:hoy, hora_fin_prevista:fin.toISOString(), hora_fin_display:finDisplay});
});

app.get('/api/historial',authW,(req,res)=>{
  const hist=queries.getHistorialMes.all(req.user.id),w=queries.getTrabajadoraById.get(req.user.id);
  const total=hist.filter(f=>f.hora_salida).reduce((a,f)=>a+(f.horas_trabajadas||0),0);
  res.json({fichajes:hist,total_horas:Math.round(total*100)/100,horas_dia_contrato:w.horas_dia,dias_mes_contrato:w.dias_mes});
});
app.get('/api/admin/dashboard',authA,(req,res)=>{
  const result=queries.getAllEmpresas.all().map(emp=>{
    const tr=queries.getEstadoHoyByEmpresa.all(emp.id);
    const st={total:tr.length,fichadas:0,jornada_completada:0,sin_fichar:0,it_baja:0,alerta:0};
    tr.forEach(t=>{if(['IT','baja','vacaciones'].includes(t.estado))st.it_baja++;else if(t.hora_entrada&&!t.hora_salida)st.fichadas++;else if(t.hora_salida)st.jornada_completada++;else{st.sin_fichar++;st.alerta++;}});
    return{empresa:emp,stats:st,trabajadoras:tr};
  });
  res.json({fecha:todayLocal(),empresas:result});
});
app.get('/api/admin/empresas',authA,(req,res)=>res.json(queries.getAllEmpresas.all()));
app.post('/api/admin/empresas',authA,(req,res)=>{
  const{nombre,nif,ccc}=req.body;if(!nombre||!nif||!ccc)return res.status(400).json({error:'Nombre, NIF y CCC obligatorios'});
  const r=queries.insertEmpresa.run(nombre.trim(),nif.trim(),ccc.trim());
  queries.insertAudit.run(req.user.username,'ALTA_EMPRESA','empresas',r.lastInsertRowid,null,JSON.stringify(req.body));
  res.json({id:r.lastInsertRowid,mensaje:'Empresa creada'});
});
app.get('/api/admin/empresas/:id/trabajadoras',authA,(req,res)=>res.json(queries.getEstadoHoyByEmpresa.all(req.params.id)));
app.get('/api/admin/trabajadoras',authA,(req,res)=>res.json(queries.getAllTrabajadoras.all()));
app.get('/api/admin/trabajadoras/:id',authA,(req,res)=>{const t=queries.getTrabajadoraById.get(req.params.id);if(!t)return res.status(404).json({error:'No encontrada'});res.json(t);});
app.post('/api/admin/trabajadoras',authA,async(req,res)=>{
  const{empresa_id,nombre,dni,telefono,horas_dia,dias_mes,tipo_jornada,estado,observaciones}=req.body;
  if(!empresa_id||!nombre||!dni||!horas_dia)return res.status(400).json({error:'Faltan campos'});
  const dniU=dni.trim().toUpperCase(),digits=dniU.replace(/[^0-9]/g,'');
  const pin=await bcrypt.hash(digits.length>=4?digits.slice(-4):'1234',10);
  try{const r=queries.insertTrabajadora.run({eid:empresa_id,nombre,dni:dniU,pin,tel:telefono||null,hd:parseFloat(horas_dia),dm:parseInt(dias_mes)||30,tj:tipo_jornada||'completa',est:estado||'activa',obs:observaciones||null,tok:generateWorkerToken()});
  queries.insertAudit.run(req.user.username,'ALTA_TRABAJADORA','trabajadoras',r.lastInsertRowid,null,JSON.stringify(req.body));
  res.json({id:r.lastInsertRowid,mensaje:'Alta realizada'});}catch(e){if(e.message.includes('UNIQUE'))return res.status(409).json({error:'DNI ya existe'});throw e;}
});
app.put('/api/admin/trabajadoras/:id',authA,(req,res)=>{
  const prev=queries.getTrabajadoraById.get(req.params.id);if(!prev)return res.status(404).json({error:'No encontrada'});
  const{nombre,telefono,horas_dia,dias_mes,tipo_jornada,estado,observaciones,horas_pendientes_confirmar}=req.body;
  queries.updateTrabajadora.run({id:req.params.id,nombre:nombre??prev.nombre,tel:telefono??prev.telefono,hd:horas_dia!=null?parseFloat(horas_dia):prev.horas_dia,dm:dias_mes!=null?parseInt(dias_mes):prev.dias_mes,tj:tipo_jornada??prev.tipo_jornada,est:estado??prev.estado,obs:observaciones??prev.observaciones,pend:horas_pendientes_confirmar!=null?(horas_pendientes_confirmar?1:0):prev.horas_pendientes_confirmar});
  queries.insertAudit.run(req.user.username,'MOD_TRABAJADORA','trabajadoras',req.params.id,JSON.stringify(prev),JSON.stringify(req.body));
  res.json({mensaje:'Actualizado'});
});
app.delete('/api/admin/trabajadoras/:id',authA,(req,res)=>{
  const prev=queries.getTrabajadoraById.get(req.params.id);if(!prev)return res.status(404).json({error:'No encontrada'});
  queries.deactivateTrabajadora.run(req.params.id);
  queries.insertAudit.run(req.user.username,'BAJA_TRABAJADORA','trabajadoras',req.params.id,JSON.stringify(prev),null);
  res.json({mensaje:'Baja registrada'});
});
app.post('/api/admin/trabajadoras/:id/regenerate-token',authA,(req,res)=>{
  const tok=generateWorkerToken();queries.updateToken.run(tok,req.params.id);
  queries.insertAudit.run(req.user.username,'REGENERAR_TOKEN','trabajadoras',req.params.id,null,JSON.stringify({token_acceso:tok}));
  res.json({token_acceso:tok});
});
app.get('/api/admin/fichajes',authA,(req,res)=>{
  const{empresa_id,trabajadora_id,fecha_inicio,fecha_fin}=req.query;
  res.json(queries.getHistorialRango.all({eid:empresa_id?parseInt(empresa_id):null,tid:trabajadora_id?parseInt(trabajadora_id):null,fi:fecha_inicio||null,ff:fecha_fin||null}));
});
app.put('/api/admin/fichajes/:id',authA,(req,res)=>{
  const prev=queries.getFichajeById.get(req.params.id);if(!prev)return res.status(404).json({error:'No encontrado'});
  const{hora_entrada,hora_salida,observaciones,razon}=req.body;
  if(!razon||razon.trim().length<5)return res.status(400).json({error:'Motivo obligatorio (min 5 chars)'});
  const he=hora_entrada??prev.hora_entrada,hs=hora_salida??prev.hora_salida,ht=(he&&hs)?calcularHorasTrabajadas(he,hs):prev.horas_trabajadas;
  queries.updateFichaje.run({id:req.params.id,he,hs,ht,obs:observaciones??prev.observaciones,admin:req.user.username,razon:razon.trim()});
  queries.insertAudit.run(req.user.username,'CORRECCION_FICHAJE','fichajes',req.params.id,JSON.stringify(prev),JSON.stringify(req.body));
  res.json({mensaje:'Fichaje corregido'});
});
app.get('/api/admin/informe-pdf/:tid/:anio/:mes',authA,(req,res)=>{
  const{tid,anio,mes}=req.params,periodo=anio+'-'+String(mes).padStart(2,'0');
  const fichs=queries.getInformeMensual.all(tid,periodo);if(!fichs.length)return res.status(404).json({error:'Sin registros'});
  const info=fichs[0],mn=new Date(periodo+'-01').toLocaleDateString('es-ES',{month:'long',year:'numeric'});
  const doc=new PDFDoc({margin:40,size:'A4'});
  res.setHeader('Content-Type','application/pdf');res.setHeader('Content-Disposition','attachment; filename="registro_'+info.dni+'_'+periodo+'.pdf"');
  doc.pipe(res);
  doc.fontSize(14).font('Helvetica-Bold').text('REGISTRO DE JORNADA',{align:'center'});
  doc.fontSize(9).font('Helvetica').text('(Art. 34.9 ET - RD-ley 8/2019)',{align:'center'});
  doc.moveDown(0.5);doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();doc.moveDown(0.3);
  const c=40;
  ['EMPRESA: '+info.empresa_nombre,'NIF: '+info.empresa_nif,'TRABAJADORA: '+info.trabajadora_nombre,'DNI: '+info.dni,'TIPO JORNADA: '+(info.tipo_jornada==='completa'?'Completo':'Parcial'),'PERIODO: '+mn].forEach(txt=>{doc.fontSize(9).font('Helvetica').text(txt,c,doc.y);});
  doc.moveDown(0.5);doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();doc.moveDown(0.3);
  const cx=[40,110,185,260,320],cw=[70,75,75,60,225];
  doc.fontSize(8).font('Helvetica-Bold');['FECHA','ENTRADA','SALIDA','HORAS','OBS'].forEach((h,i)=>doc.text(h,cx[i],doc.y,{width:cw[i]}));
  doc.moveDown(0.2);doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();doc.moveDown(0.1);
  let tot=0,dias=0;doc.font('Helvetica').fontSize(8);
  fichs.forEach(f=>{
    const y=doc.y,fe=new Date(f.fecha+'T12:00:00').toLocaleDateString('es-ES',{weekday:'short',day:'2-digit',month:'2-digit',year:'numeric'});
    let hs='';if(f.horas_trabajadas!=null){hs=decimalToHHMM(f.horas_trabajadas);tot+=f.horas_trabajadas;dias++;}
    const obs=[f.cerrado_automaticamente?'Auto':'',f.observaciones||'',f.modificado_por?'Corr':''].filter(Boolean).join('; ');
    doc.text(fe,cx[0],y,{width:cw[0]});doc.text(horaDisplay(f.hora_entrada),cx[1],y,{width:cw[1]});doc.text(horaDisplay(f.hora_salida),cx[2],y,{width:cw[2]});doc.text(hs,cx[3],y,{width:cw[3]});doc.text(obs,cx[4],y,{width:cw[4]});
    doc.moveDown(0.15);if(doc.y>750)doc.addPage();
  });
  doc.moveDown(0.3);doc.moveTo(40,doc.y).lineTo(555,doc.y).stroke();doc.moveDown(0.2);
  doc.fontSize(9).font('Helvetica-Bold').text('Dias: '+dias+' | TOTAL: '+decimalToHHMM(tot),c);
  doc.moveDown(1);doc.fontSize(7).font('Helvetica').text('Webgest. Conservacion minima 4 anos (art. 34.9 ET).',{align:'justify'});
  doc.end();
});
app.get('/api/admin/audit',authA,(req,res)=>res.json(db.prepare('SELECT * FROM audit_log ORDER BY created_at DESC LIMIT 200').all()));
cron.schedule('* * * * *',()=>{
  const ah=new Date();
  queries.getFichajesAbiertos.all().forEach(f=>{
    const fin=calcularHoraFin(f.hora_entrada,f.horas_dia);
    if(ah>=fin){const s=fin.toISOString().replace('T',' ').slice(0,19);queries.closeFichaje.run(s,calcularHorasTrabajadas(f.hora_entrada,s),1,f.id);smsFin(f.telefono,fin);}
  });
});
app.get('/w/:token',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin',(req,res)=>res.sendFile(path.join(__dirname,'public','admin.html')));
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
app.listen(PORT,'0.0.0.0',()=>console.log('OK puerto '+PORT));
