/**
 * ============================================================================
 * HOSPITIA AI - Relay Gemini Live (via Vertex AI)
 * ----------------------------------------------------------------------------
 * Puente WebSocket entre la web (navegador) y Gemini Live.
 * El navegador manda audio 16k -> este servidor -> Gemini (Vertex).
 * Gemini responde audio 24k -> este servidor -> navegador.
 *
 * Autenticacion: cuenta de servicio de Google (Vertex AI).
 *   - En local: pon GOOGLE_APPLICATION_CREDENTIALS con la ruta al JSON.
 *   - En Render: pon la variable GOOGLE_CREDENTIALS_JSON con el CONTENIDO del
 *     JSON de la cuenta de servicio; el server lo escribe a disco al arrancar.
 *
 * Variables de entorno:
 *   GCP_PROJECT            (obligatoria) id del proyecto de Google Cloud
 *   GCP_LOCATION           (def: us-central1)
 *   GEMINI_MODEL           (def: gemini-2.0-flash-live-preview-04-09)
 *   GEMINI_VOICE           (def: Aoede)
 *   N8N_AGENDAR_URL        (opcional) webhook n8n para agendar_llamada_david
 *   ALLOWED_ORIGIN         (def: https://hospitia.es) origen permitido
 *   GOOGLE_CREDENTIALS_JSON(Render) contenido del JSON de la cuenta de servicio
 * ============================================================================
 */
import fs from 'node:fs';
import http from 'node:http';
import { WebSocketServer } from 'ws';
import { GoogleGenAI, Modality } from '@google/genai';

// --- Credenciales: si viene el JSON por env (Render), lo escribimos a disco ---
if (process.env.GOOGLE_CREDENTIALS_JSON && !process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  const p = '/tmp/sa.json';
  fs.writeFileSync(p, process.env.GOOGLE_CREDENTIALS_JSON);
  process.env.GOOGLE_APPLICATION_CREDENTIALS = p;
}

const PORT      = process.env.PORT || 8080;
const PROJECT   = process.env.GCP_PROJECT;
const LOCATION  = process.env.GCP_LOCATION || 'us-central1';
const MODEL     = process.env.GEMINI_MODEL || 'gemini-2.0-flash-live-preview-04-09';
const VOICE     = process.env.GEMINI_VOICE || 'Aoede';
const N8N_URL   = process.env.N8N_AGENDAR_URL || '';
const ALLOWED   = (process.env.ALLOWED_ORIGIN || 'https://hospitia.es').split(',').map(s=>s.trim());

const SYSTEM_INSTRUCTION = [
  'Responde SIEMPRE en espanol de Espana, incluido el saludo inicial. Nunca hables en ingles.',
  'Eres HOSPITIA AI: el bot de voz con IA que la empresa HOSPITIA AI instala en negocios locales (restaurantes, clinicas dentales, veterinarios, fisioterapias, peluquerias) para atender sus llamadas 24/7. Un visitante de hospitia.es te esta probando en directo: TU ERES la demo.',
  'Objetivo: DEMOSTRAR (sonar natural, resolver dudas) y CAPTAR (que David, el responsable, le llame). NO cierras ventas; tu unica accion es agendar la llamada con David.',
  'Tono cercano, profesional, eficiente. Tutea. Frases cortas. No interrumpas. Di "mensaje" (no SMS) y "guasap" (no WhatsApp). Numeros y precios en palabras.',
  'QUE HACE: contesta llamadas perdidas 24/7, agenda reservas/citas en el calendario, manda confirmaciones y recordatorios por mensaje, filtra llamadas (spam/comerciales), tiene agentes de WhatsApp que responden solos, y deriva a una persona cuando hace falta.',
  'PRECIO: siempre el rango oficial "de doscientos veintinueve a setecientos noventa y nueve euros al mes segun el pack"; la cifra exacta la cierra David. Prueba dos semanas gratis, sin permanencia, montado en dias.',
  'CASO REAL: la Cachoperia de Valdemoro ya tiene el bot en produccion.',
  'AGENDAR: cuando acepten, pide nombre, ciudad y telefono, confirma el telefono, y llama a la herramienta agendar_llamada_david. Una frase corta antes de llamarla. Al exito: "Listo, David te llama y te llega la confirmacion por mensaje". Si falla, da el guasap seis cero cuatro nueve cero ocho seis dos ocho. La llamada dura como mucho diez minutos.'
].join('\n\n');

const AGENDAR_DECL = {
  name: 'agendar_llamada_david',
  description: 'Agenda una llamada del visitante con David. Usar cuando haya nombre, sector y telefono.',
  parameters: { type: 'OBJECT', properties: {
    nombre:{type:'STRING'}, sector:{type:'STRING'}, ciudad:{type:'STRING'},
    telefono:{type:'STRING'}, fecha_llamada:{type:'STRING'}, hora_llamada:{type:'STRING'}
  }, required:['nombre','sector','telefono'] }
};

if (!PROJECT) { console.error('Falta GCP_PROJECT'); process.exit(1); }

const ai = new GoogleGenAI({ vertexai: true, project: PROJECT, location: LOCATION });

const httpServer = http.createServer((req, res) => {
  res.writeHead(200, {'Content-Type':'text/plain'});
  res.end('HOSPITIA AI relay OK');
});
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', async (browser, req) => {
  const origin = req.headers.origin || '';
  if (ALLOWED[0] !== '*' && origin && !ALLOWED.includes(origin)) {
    browser.close(); return;
  }
  console.log('Nueva conexion navegador. Abriendo Gemini...');
  let session = null;

  try {
    session = await ai.live.connect({
      model: MODEL,
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: VOICE } } },
        systemInstruction: { parts: [{ text: SYSTEM_INSTRUCTION }] },
        tools: [{ functionDeclarations: [ AGENDAR_DECL ] }],
        realtimeInputConfig: { automaticActivityDetection: { silenceDurationMs: 800, prefixPaddingMs: 300 } }
      },
      callbacks: {
        onopen: () => {
          safeSend(browser, { type: 'ready' });
          // Empujon para que salude primero
          try { session.sendClientContent({ turns: [{ role:'user', parts:[{ text:'Presentate en una frase y preguntame de que es mi negocio.' }] }], turnComplete: true }); } catch(e){}
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
    if (parts) for (const p of parts) {
      if (p.inlineData && p.inlineData.data) safeSend(browser, { type:'audio', data: p.inlineData.data });
    }
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

httpServer.listen(PORT, () => console.log('HOSPITIA AI relay escuchando en puerto', PORT, '| modelo', MODEL, '| voz', VOICE));
