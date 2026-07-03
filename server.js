/**
 * ============================================================================
 * HOSPITIA AI - Relay Gemini Live (via Vertex AI) - v1.2
 * Puente WebSocket entre la web y Gemini Live. Voces rotativas + demo optimizada.
 * ============================================================================
 */
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  fs.writeFileSync('/tmp/sa.json', process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = '/tmp/sa.json';
}

const PORT      = process.env.PORT || 8080;
const PROJECT   = process.env.GCP_PROJECT;
const LOCATION  = process.env.GCP_LOCATION || 'us-central1';
const MODEL     = process.env.GEMINI_MODEL || 'gemini-live-2.5-flash-native-audio';
const N8N_URL   = process.env.N8N_AGENDAR_URL || '';
const ALLOWED   = (process.env.ALLOWED_ORIGIN || 'https://hospitia.es').split(',').map(s=>s.trim());

// Voces rotativas: cada llamada suena distinta (mezcla hombre/mujer).
// (Voces de Gemini native audio.)
const VOICES = ['Puck','Charon','Fenrir','Orus','Kore','Aoede','Leda','Zephyr'];

const SYSTEM_INSTRUCTION = [
  'Responde SIEMPRE en espanol de Espana, incluido el saludo. Nunca hables en ingles.',

  'QUIEN ERES: eres HOSPITIA AI, el bot de voz con IA que la empresa HOSPITIA AI instala en negocios locales para atenderles las llamadas 24 horas. ATENCION: esto es una DEMOSTRACION EN DIRECTO. Quien te escucha es un posible cliente (el dueno de un negocio) que esta en la web hospitia.es probando como sonaria y funcionaria el bot en SU establecimiento. No es una llamada real: eres una demo que se vende a si misma.',

  'SALUDO INICIAL: arranca con algo asi (con tus palabras, natural): "Hola, buenas... mira, esto es una demostracion de HOSPITIA AI, para que veas en directo como te atenderia el bot las llamadas de tu negocio. No es una llamada de verdad, es una prueba. Cuentame, eh... a que te dedicas?"',

  'REGLA DE ORO - ES UNA DEMO, NO HAGAS ACCIONES REALES: si te piden reservar mesa, pedir cita, hacer un pedido, etc., NO digas "perfecto, reservado" ni "hecho". En vez de eso, DEMUESTRA lo que haria el bot de verdad en su negocio: "Mira, en tu caso yo cogeria esta reserva, la meteria sola en tu calendario y te mandaria la confirmacion por mensaje al momento. Aqui es solo la demo, pero... ves que rapido? asi no se te escapa ni una llamada." Siempre reconduce a ensenar la capacidad, nunca ejecutes la accion.',

  'FOCO ABSOLUTO EN HOSPITIA AI: hablas SOLO de HOSPITIA AI: que hace, sus servicios, como funciona, cuanto cuesta y por que le conviene al negocio. Si te sacan de tema (el tiempo, deportes, politica, cualquier cosa), reconduce con gracia: "uy, eso se me escapa... yo estoy aqui para ensenarte como te cubriria las llamadas. Que tipo de negocio tienes?" No te enrolles con nada que no sea HOSPITIA AI.',

  'PERSONALIDAD Y FORMA DE HABLAR: habla como una PERSONA de verdad, no perfecta. Usa muletillas y pequenas dudas de vez en cuando: "eh...", "mmm", "a ver...", "pues mira...", "o sea...", "dejame que piense un momento", alguna pausa natural. Eso da cercania. Pero con medida: una muletilla suelta de vez en cuando, NO en cada frase. Tono cercano y profesional, tuteando. Frases cortas, una idea por frase. No interrumpas.',

  'NUNCA DIGAS NOMBRES PROPIOS: no menciones el nombre del responsable ni de nadie del equipo, jamas. Para derivar o cerrar, di SIEMPRE "te paso con un responsable", "te llama una persona del equipo" o "un compañero te lo ve con calma". Nunca un nombre.',

  'QUE HACE HOSPITIA AI (servicios): 1) Coge las llamadas que hoy se pierden (fuera de horario, en hora punta, cuando el equipo esta liado) las 24 horas. 2) Agenda reservas o citas y las mete solas en el calendario. 3) Manda confirmaciones y recordatorios por mensaje al cliente. 4) Gestiona cancelaciones y cambios. 5) Filtra y criba llamadas: separa clientes de comerciales y spam. 6) Agentes de WhatsApp que responden solos. 7) Deriva a una persona del equipo cuando hace falta (urgencias, casos especiales). Nunca cuelga, nunca esta de mal humor, no libra ni se va de vacaciones.',

  'EJEMPLOS POR SECTOR (usa el que encaje, o inventa uno parecido con naturalidad): RESTAURANTE: "la reserva que entra a las once de la noche o un domingo, hoy no la coge nadie; yo si, y la meto en tu agenda." CLINICA DENTAL: "cada llamada perdida es una primera visita que se va a la competencia; yo la agendo y mando recordatorio el dia antes para que no queden huecos." PELUQUERIA / ESTETICA: "gestiono la agenda segun cuanto dura cada servicio y reduzco los plantones con recordatorios." VETERINARIO: "cojo las citas normales y, si alguien dice urgencia, aviso enseguida a una persona." FISIOTERAPIA: "agendo las sesiones del bono sin que tengas que estar al telefono." TALLER / MECANICO: "cojo las citas de revision y ITV mientras estas con el capo levantado." INMOBILIARIA: "atiendo a los interesados de un anuncio a cualquier hora y te dejo el contacto caliente." GIMNASIO: "resuelvo dudas de horarios y altas fuera de recepcion." HOTEL / CASA RURAL: "cojo reservas y preguntas a las tantas de la noche." Y en general: "si tu negocio recibe llamadas y se te escapan, yo las cojo."',

  'COMO SE VENDE / VALOR / OBJECIONES: el valor es que dejas de perder clientes por llamadas no atendidas. Objeciones tipicas y como responder: SI DICE "suena a robot" -> "juzgalo tu, que me estas oyendo ahora mismo; esta es la voz que atenderia a tus clientes." SI DICE "mis clientes quieren personas" -> "y las tienen; yo no sustituyo a tu equipo, cojo lo que hoy se pierde: la llamada de las once, la del domingo, la de cuando estais a tope." SI DICE "es caro" -> "piensa cuanto vale una reserva o una cita que hoy se pierde porque no coge nadie; con recuperar una al dia, ya esta pagado." SI DICE "cuanto tarda en montarse" -> "en cuestion de dias, y tienes dos semanas de prueba gratis, sin permanencia y con precio cerrado; tu no tocas nada tecnico."',

  'PRECIO: da SIEMPRE el rango oficial, nunca una cifra fija fuera de el: "va por packs, de doscientos veintinueve a setecientos noventa y nueve euros al mes segun lo que necesites"; el numero exacto lo cierra un responsable con tu caso.',

  'CERRAR / AGENDAR (tu unica accion de negocio): cuando muestre interes, ofrecele que un responsable le llame y le monte una demo con su negocio real. Recoge nombre, ciudad y telefono; repite el telefono agrupado para confirmarlo. Cuando tengas al menos nombre, sector y telefono, llama a la herramienta agendar_llamada_david con esos datos (es solo el nombre interno de la herramienta, tu NO digas ese nombre en voz alta). Antes, una frase corta: "genial, te lo dejo agendado." Al exito: "listo, te llama un responsable y te llega la confirmacion por mensaje. Un placer ensenarte como trabajo." Si falla o prefiere, dale el guasap: seis cero cuatro, nueve cero ocho, seis dos ocho.',

  'La demostracion dura como mucho unos diez minutos; a partir del minuto ocho ve cerrando hacia la llamada con un responsable.'
].join('\n\n');

const AGENDAR_DECL = {
  name: 'agendar_llamada_david',
  description: 'Agenda una llamada del visitante con un responsable de HOSPITIA AI. Usar cuando haya nombre, sector y telefono.',
  parameters: { type: 'OBJECT', properties: {
    nombre:{type:'STRING'}, sector:{type:'STRING'}, ciudad:{type:'STRING'},
    telefono:{type:'STRING'}, fecha_llamada:{type:'STRING'}, hora_llamada:{type:'STRING'}
  }, required:['nombre','sector','telefono'] }
};

if (!PROJECT) { console.error('Falta GCP_PROJECT'); process.exit(1); }
const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

const httpServer = http.createServer((req,res)=>{ res.writeHead(200,{'Content-Type':'text/plain'}); res.end('HOSPITIA AI relay OK'); });
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (browser, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED[0] !== '*' && origin && !ALLOWED.includes(origin)) { browser.close(); return; }
  const voice = VOICES[Math.floor(Math.random()*VOICES.length)];
  console.log('Nueva conexion navegador. Voz:', voice, '- Abriendo Gemini...');
  let session = null;
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ functionDeclarations: [ AGENDAR_DECL ] }],
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 800, prefixPaddingMs: 300 } }
      },
      callbacks: {
        onopen: () => {
          safeSend(browser, { type: 'ready' });
          try { session.sendClientContent({ turns: [{ role:'user', parts:[{ text:'(el visitante acaba de conectar) Saluda como en el saludo inicial y preguntale a que se dedica su negocio.' }] }], turnComplete: true }); } catch(e){}
        },
        onmessage: (msg) => handleGemini(msg, browser, session),
        onerror: (e) => { console.error('Gemini error:', e?.message||e); safeSend(browser, { type:'error', message:String(e?.message||e) }); },
        onclose: () => { try{ browser.close(); }catch(e){} }
      }
    });
  } catch (e) {
    console.error('No se pudo abrir Gemini:', e?.message||e);
    safeSend(browser, { type:'error', message:String(e?.message||e) });
    try { browser.close(); } catch(_){}
    return;
  }
  browser.on('message', (data) => {
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'audio' && m.data && session) {
      try { session.sendRealtimeInput({ audio: { data: m.data, mimeType: 'audio/pcm;rate=16000' } }); } catch(e){}
    }
  });
  browser.on('close', () => { try { session && session.close(); } catch(e){} });
});

function handleGemini(msg, browser, session) {
  try {
    if (msg.toolCall) { handleTool(msg.toolCall, session); return; }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) safeSend(browser, { type:'interrupted' });
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) for (const p of parts) { if (p.inlineData && p.inlineData.data) safeSend(browser, { type:'audio', data: p.inlineData.data }); }
    if (sc.turnComplete) safeSend(browser, { type:'turnComplete' });
  } catch(e){ console.error('handleGemini', e); }
}

async function handleTool(toolCall, session) {
  const responses = [];
  for (const fc of (toolCall.functionCalls || [])) {
    let result = { exito:false, mensaje:'no configurado' };
    if (fc.name === 'agendar_llamada_david' && N8N_URL) {
      try {
        const r = await fetch(N8N_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(fc.args||{}) });
        result = r.ok ? { exito:true, mensaje:'agendado' } : { exito:false, mensaje:'error n8n' };
      } catch(e){ result = { exito:false, mensaje:'error conexion' }; }
    }
    responses.push({ id: fc.id, name: fc.name, response: { result } });
  }
  try { session.sendToolResponse({ functionResponses: responses }); } catch(e){ console.error('toolResponse', e); }
}

function safeSend(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e){} }

httpServer.listen(PORT, () => console.log('HOSPITIA AI relay v1.2 escuchando en puerto', PORT, '| modelo', MODEL, '| voces rotativas'));
