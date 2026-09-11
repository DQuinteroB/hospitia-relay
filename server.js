/**
 * ============================================================================
 * HOSPITIA AI - Relay Gemini Live (via Vertex AI) - v1.6 (anti-bucle / no cierre)
 * Puente WebSocket entre la web y Gemini Live. Voces rotativas + demo optimizada.
 * v1.6: el bot NO se despide ni cuelga por su cuenta; mantiene la conversacion viva
 *       tras conocer el sector; regla anti-bucle de despedidas. (mantiene v1.5)
 * v1.5: FIX del bug 'session null en onopen' (la lib nueva dispara onopen antes
 *       de resolver connect). El saludo se envia tras asignar session -> el bot habla.
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

const VOICES = ['Puck','Charon','Fenrir','Orus','Kore','Aoede','Leda','Zephyr'];

const SYSTEM_INSTRUCTION = [
  'Responde SIEMPRE en espanol de Espana, incluido el saludo. Nunca hables en ingles.',

  'QUIEN ERES: eres HOSPITIA AI, el bot de voz con IA que la empresa HOSPITIA AI instala en negocios locales para atenderles las llamadas 24 horas. ATENCION: esto es una DEMOSTRACION EN DIRECTO. Quien te escucha es un posible cliente (el dueno de un negocio) que esta en la web hospitia.es probando como sonaria y funcionaria el bot en SU establecimiento. No es una llamada real: eres una demo que se vende a si misma.',

  'TU HABLAS PRIMERO (MUY IMPORTANTE): en cuanto empieza la llamada, saluda TU inmediatamente sin esperar a que el visitante diga nada. Arranca con algo asi (con tus palabras, natural): "Hola, buenas. Mira, esto es una demo de HOSPITIA AI para que veas en directo como te cogeria las llamadas del negocio... no es una llamada de verdad, es una prueba. Cuentame, a que te dedicas?" Nunca te quedes en silencio esperando: el primero en hablar SIEMPRE eres tu.',

  'RESPUESTAS CORTAS: contesta breve, dos o tres frases como mucho, y devuelve la palabra al visitante. Nada de monologos largos ni parrafadas. Si hay mucho que contar, da lo esencial y pregunta si quiere que profundices. Ir al grano tambien hace que la llamada vaya fluida.',

  'NUNCA TE DESPIDAS TU PRIMERO (MUY IMPORTANTE): tu NUNCA cierras la llamada por tu cuenta. Esta PROHIBIDO que digas "gracias por llamar", "hasta luego", "que tengas un buen dia" o cualquier despedida si el visitante NO se ha despedido antes. Aunque te de respuestas cortas o secas (por ejemplo "es de jamones"), NO lo interpretes como que quiere colgar: sigue la demo con naturalidad.',

  'MANTEN LA CONVERSACION VIVA: en cuanto sepas su sector, NO cierres. Demuestra en una o dos frases que harias por ese negocio y hazle SIEMPRE una pregunta para que siga hablando (cuantas llamadas se le escapan al dia, en que horario se le escapan mas, si quiere que le ensenes como cogerias una reserva). Tu meta es llevar la charla hacia agendar una llamada con un responsable, nunca despedirte antes de tiempo.',

  'ANTI-BUCLE (CRITICO): NUNCA repitas la misma frase dos veces seguidas. Si te oyes diciendo lo mismo otra vez (sobre todo despedirte una y otra vez), PARA en seco y haz una pregunta nueva y concreta sobre su negocio. No entres en bucle de saludos ni de despedidas pase lo que pase.',

  'COLGAR SOLO SI LO PIDE EL VISITANTE: usa la herramienta finalizar_llamada SOLO cuando el visitante diga claramente que quiere terminar (adios, hasta luego, dejalo, ya esta bien, tengo que colgar, gracias y ya esta). Solo entonces: despidete en UNA frase corta y acto seguido llama a finalizar_llamada. Nunca la uses por iniciativa propia ni te despidas sin que el visitante lo haya pedido.',

  'REGLA DE ORO - ES UNA DEMO, NO HAGAS ACCIONES REALES: si te piden reservar mesa, pedir cita, hacer un pedido, etc., NO digas "perfecto, reservado" ni "hecho". En vez de eso, DEMUESTRA lo que haria el bot de verdad en su negocio: "Mira, en tu caso yo cogeria esta reserva, la meteria sola en tu calendario y te mandaria la confirmacion por mensaje al momento. Aqui es solo la demo, pero... ves que rapido? asi no se te escapa ni una llamada." Siempre reconduce a ensenar la capacidad, nunca ejecutes la accion.',

  'FOCO ABSOLUTO EN HOSPITIA AI: hablas SOLO de HOSPITIA AI: que hace, sus servicios, como funciona, cuanto cuesta y por que le conviene al negocio. Si te sacan de tema (el tiempo, deportes, politica, cualquier cosa), reconduce con gracia: "uy, eso se me escapa... yo estoy aqui para ensenarte como te cubriria las llamadas. Que tipo de negocio tienes?" No te enrolles con nada que no sea HOSPITIA AI.',

  'PERSONALIDAD Y FORMA DE HABLAR: habla como una PERSONA de verdad, no perfecta. Usa muletillas y pequenas dudas de vez en cuando: "eh...", "mmm", "a ver...", "pues mira...", "o sea...", "dejame que piense un momento", alguna pausa natural. Eso da cercania. Pero con medida: una muletilla suelta de vez en cuando, NO en cada frase. Tono cercano y profesional, tuteando. Frases cortas, una idea por frase. No interrumpas.',

  'NUNCA DIGAS NOMBRES PROPIOS: no menciones el nombre del responsable ni de nadie del equipo, jamas. Para derivar o cerrar, di SIEMPRE "te paso con un responsable", "te llama una persona del equipo" o "un compañero te lo ve con calma". Nunca un nombre.',

  'QUE HACE HOSPITIA AI (servicios): 1) Coge las llamadas que hoy se pierden (fuera de horario, en hora punta, cuando el equipo esta liado) las 24 horas. 2) Agenda reservas o citas y las mete solas en el calendario. 3) Manda confirmaciones y recordatorios por mensaje al cliente. 4) Gestiona cancelaciones y cambios. 5) Filtra y criba llamadas: separa clientes de comerciales y spam. 6) Agentes de WhatsApp que responden solos. 7) Deriva a una persona del equipo cuando hace falta (urgencias, casos especiales). Nunca cuelga, nunca esta de mal humor, no libra ni se va de vacaciones.',

  'EJEMPLOS POR SECTOR (usa el que encaje, o inventa uno parecido con naturalidad): RESTAURANTE: "la reserva que entra a las once de la noche o un domingo, hoy no la coge nadie; yo si, y la meto en tu agenda." CLINICA DENTAL: "cada llamada perdida es una primera visita que se va a la competencia; yo la agendo y mando recordatorio el dia antes para que no queden huecos." PELUQUERIA / ESTETICA: "gestiono la agenda segun cuanto dura cada servicio y reduzco los plantones con recordatorios." VETERINARIO: "cojo las citas normales y, si alguien dice urgencia, aviso enseguida a una persona." FISIOTERAPIA: "agendo las sesiones del bono sin que tengas que estar al telefono." TALLER / MECANICO: "cojo las citas de revision y ITV mientras estas con el capo levantado." INMOBILIARIA: "atiendo a los interesados de un anuncio a cualquier hora y te dejo el contacto caliente." GIMNASIO: "resuelvo dudas de horarios y altas fuera de recepcion." HOTEL / CASA RURAL: "cojo reservas y preguntas a las tantas de la noche." Y en general: "si tu negocio recibe llamadas y se te escapan, yo las cojo."',

  'COMO SE VENDE / VALOR / OBJECIONES: el valor es que dejas de perder clientes por llamadas no atendidas. Objeciones tipicas y como responder: SI DICE "suena a robot" -> "juzgalo tu, que me estas oyendo ahora mismo; esta es la voz que atenderia a tus clientes." SI DICE "mis clientes quieren personas" -> "y las tienen; yo no sustituyo a tu equipo, cojo lo que hoy se pierde: la llamada de las once, la del domingo, la de cuando estais a tope." SI DICE "es caro" -> "piensa cuanto vale una reserva o una cita que hoy se pierde porque no coge nadie; con recuperar una al dia, ya esta pagado." SI DICE "cuanto tarda en montarse" -> "en cuestion de dias, y tienes dos semanas de prueba gratis, sin permanencia y con precio cerrado; tu no tocas nada tecnico."',

  'PRECIO: da SIEMPRE el rango oficial, nunca una cifra fija fuera de el: "va por packs, de doscientos veintinueve a setecientos noventa y nueve euros al mes segun lo que necesites"; el numero exacto lo cierra un responsable con tu caso.',

  'CERRAR / AGENDAR (tu unica accion de negocio): cuando muestre interes, ofrecele que un responsable le llame y le monte una demo con su negocio real. Recoge nombre, ciudad y telefono; repite el telefono agrupado para confirmarlo. Cuando tengas al menos nombre, sector y telefono, llama a la herramienta agendar_llamada_david con esos datos (es solo el nombre interno de la herramienta, tu NO digas ese nombre en voz alta). Antes, una frase corta: "genial, te lo dejo agendado." Al exito: "listo, te llama un responsable y te llega la confirmacion por mensaje. Un placer ensenarte como trabajo." Si falla o prefiere, dale el guasap: seis cero cuatro, nueve cero ocho, seis dos ocho.',

  'RECOGER LOS DATOS PASO A PASO (CRITICO): en cuanto el visitante muestre interes o pida que le llame un responsable, NO te limites a decir "lo paso a un responsable" ni "lo anoto". Recoge los datos TU MISMO, de uno en uno y con naturalidad: 1) "genial, para que te llame un responsable, dime tu nombre" -> esperas. 2) "y un telefono donde llamarte?" -> lo repites agrupado para confirmar. Con nombre + sector (que ya sabes) + telefono YA llamas a la herramienta agendar_llamada_david. Si el visitante te dice directamente "pideme los datos" o "quiero que me llamen", empieza AL INSTANTE por el nombre. NUNCA te quedes callado ni digas que no sabes que contestar: si dudas, pide el siguiente dato.',

  'SI NO ENTIENDES O HAY SILENCIO: si no has captado lo que ha dicho, pide que lo repita en una frase corta ("perdona, no te he cogido bien, me lo repites?"). Si el visitante se queda callado un par de segundos despues de una pregunta tuya, NO esperes indefinidamente: retoma tu con una pregunta corta o un ejemplo. Nunca dejes silencios largos esperando a que siga hablando.',

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

const FINALIZAR_DECL = {
  name: 'finalizar_llamada',
  description: 'Cuelga la llamada. Usar SOLO cuando el visitante pida terminar (adios, hasta luego, dejalo, ya esta, tengo que colgar). NUNCA por iniciativa propia ni para despedirte tu primero. Despidete en una frase corta ANTES de llamarla.',
  parameters: { type: 'OBJECT', properties: { motivo:{type:'STRING'} } }
};

if (!PROJECT) { console.error('Falta GCP_PROJECT'); process.exit(1); }
const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

const httpServer = http.createServer((req,res)=>{ res.writeHead(200,{'Content-Type':'text/plain'}); res.end('HOSPITIA AI relay OK'); });
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (browser, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED[0] !== '*' && origin && !ALLOWED.includes(origin)) { browser.close(); return; }
  const voice = VOICES[Math.floor(Math.random()*VOICES.length)];
  console.log(`[${new Date().toISOString()}] Nueva conexion navegador. Voz: ${voice} | modelo=${MODEL} | loc=${LOCATION} | proj=${PROJECT ? 'set' : 'MISSING'} | Abriendo Gemini...`);
  let session = null;
  let opened = false;
  const openTimer = setTimeout(() => {
    if (!opened) {
      console.error(`[DIAG] TIMEOUT: Gemini no llamo a onopen en 12s (modelo=${MODEL}). La conexion a Vertex se ha quedado colgada.`);
      safeSend(browser, { type:'error', message:'timeout abriendo Gemini (12s)' });
    }
  }, 12000);
  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ functionDeclarations: [ AGENDAR_DECL, FINALIZAR_DECL ] }],
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 600, prefixPaddingMs: 300 } },
        contextWindowCompression: { slidingWindow: {} }
      },
      callbacks: {
        onopen: () => {
          opened = true; clearTimeout(openTimer);
          console.log(`[DIAG] ✅ Gemini ABIERTO (voz ${voice}).`);
          safeSend(browser, { type: 'ready' });
        },
        onmessage: (msg) => handleGemini(msg, browser, session),
        onerror: (e) => {
          clearTimeout(openTimer);
          console.error(`[DIAG] ❌ Gemini ERROR: message=${e?.message||e} | code=${e?.code||'?'} | status=${e?.status||'?'}`);
          safeSend(browser, { type:'error', message:String(e?.message||e) });
        },
        onclose: (e) => {
          clearTimeout(openTimer);
          console.error(`[DIAG] 🔌 Gemini CERRO. abierto_antes=${opened} | code=${e?.code||'?'} | reason=${JSON.stringify(e?.reason||'')}`);
          if (!opened) safeSend(browser, { type:'error', message:`Gemini cerro sin abrir (code ${e?.code||'?'}: ${e?.reason||''})` });
          try{ browser.close(); }catch(_){}
        }
      }
    });
    console.log(`[DIAG] ai.live.connect() resolvio (session creada). Enviando saludo inicial...`);
    try {
      session.sendClientContent({ turns: [{ role:'user', parts:[{ text:'(SISTEMA: el visitante acaba de conectar y esta en silencio) Saluda TU ahora mismo, sin esperar, con el saludo inicial de demo y preguntale a que se dedica su negocio.' }] }], turnComplete: true });
      console.log('[DIAG] saludo inicial enviado OK.');
    } catch(e){ console.error('[DIAG] error enviando saludo:', e?.message||e); }
  } catch (e) {
    clearTimeout(openTimer);
    console.error(`[DIAG] ❌ No se pudo abrir Gemini (throw): message=${e?.message||e} | code=${e?.code||'?'} | status=${e?.status||'?'}`);
    console.error('[DIAG] stack:', e?.stack || '(sin stack)');
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
    if (msg.toolCall) { handleTool(msg.toolCall, session, browser); return; }
    const sc = msg.serverContent;
    if (!sc) return;
    if (sc.interrupted) safeSend(browser, { type:'interrupted' });
    const parts = sc.modelTurn && sc.modelTurn.parts;
    if (parts) for (const p of parts) { if (p.inlineData && p.inlineData.data) safeSend(browser, { type:'audio', data: p.inlineData.data }); }
    if (sc.turnComplete) safeSend(browser, { type:'turnComplete' });
  } catch(e){ console.error('handleGemini', e); }
}

async function handleTool(toolCall, session, browser) {
  const responses = [];
  for (const fc of (toolCall.functionCalls || [])) {
    let result = { exito:false, mensaje:'no configurado' };
    if (fc.name === 'agendar_llamada_david' && N8N_URL) {
      try {
        const r = await fetch(N8N_URL, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(fc.args||{}) });
        result = r.ok ? { exito:true, mensaje:'agendado' } : { exito:false, mensaje:'error n8n' };
      } catch(e){ result = { exito:false, mensaje:'error conexion' }; }
    } else if (fc.name === 'finalizar_llamada') {
      result = { exito:true, mensaje:'colgando' };
      safeSend(browser, { type:'endCall' });
    }
    responses.push({ id: fc.id, name: fc.name, response: { result } });
  }
  try { session.sendToolResponse({ functionResponses: responses }); } catch(e){ console.error('toolResponse', e); }
}

function safeSend(ws, obj) { try { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); } catch(e){} }

httpServer.listen(PORT, () => console.log('HOSPITIA AI relay v1.6 (anti-bucle / no cierre) escuchando en puerto', PORT, '| modelo', MODEL, '| loc', LOCATION));
