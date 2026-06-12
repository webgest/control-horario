'use strict';

let twilioClient = null;

function getTwilioClient() {
  if (twilioClient) return twilioClient;
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  if (sid && token && sid.startsWith('AC')) {
    twilioClient = require('twilio')(sid, token);
  }
  return twilioClient;
}

async function sendSMS(to, body) {
  if (!to) { console.log('[SMS] Sin telefono. Mensaje: ' + body); return; }
  const client = getTwilioClient();
  const from   = process.env.TWILIO_PHONE_NUMBER;
  if (!client || !from) { console.log('[SMS DEMO -> ' + to + '] ' + body); return; }
  try {
    const msg = await client.messages.create({ body, from, to });
    console.log('[SMS] Enviado a ' + to + ': ' + msg.sid);
  } catch (err) {
    console.error('[SMS] Error al enviar a ' + to + ':', err.message);
  }
}

function smsFin(telefono, horaFin) {
  const hora = horaFin instanceof Date
    ? horaFin.toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' })
    : horaFin;
  return sendSMS(telefono, 'Tu jornada de hoy ha finalizado a las ' + hora + '. Descansa, hasta manana!');
}

module.exports = { sendSMS, smsFin };