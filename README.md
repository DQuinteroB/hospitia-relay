# hospitia-relay

Dos servicios independientes en el mismo repositorio:

| Servicio | Arranque | Para qué |
|---|---|---|
| Demo web | `npm start` (`server.js`) | Demo de voz de hospitia.es: navegador ↔ Gemini Live (Vertex AI) |
| Relay telefónico | `npm run start:telefono` (`telefono.js`) | Bot de voz para clientes: Twilio ↔ Gemini Live (Vertex AI), sin Vapi |

Ninguno de los dos graba audio ni guarda transcripciones.

## Relay telefónico (`telefono.js`)

1. Twilio recibe la llamada y hace `POST /twilio/voice`. Se valida la firma de Twilio.
2. Se busca el cliente por el número llamado y se responde TwiML `<Connect><Stream>`.
3. Twilio abre `wss://…/twilio/stream` (μ-law 8 kHz). El audio se convierte a PCM 16 kHz para Gemini y la voz de Gemini (24 kHz) se devuelve en μ-law 8 kHz.
4. Las herramientas `consultar_disponibilidad`, `crear_reserva` y `cancelar_reserva` hacen `POST` a los webhooks de n8n del cliente con la cabecera secreta.

### Variables de entorno (servicio de Render aparte)

| Variable | Obligatoria | Uso |
|---|---|---|
| `GCP_PROJECT`, `GCP_LOCATION`, `GOOGLE_CREDENTIALS_JSON`, `GEMINI_MODEL` | Sí | Igual que la demo |
| `PUBLIC_URL` | Sí | URL pública del servicio, p. ej. `https://<servicio>.onrender.com` (para validar la firma de Twilio) |
| `TWILIO_AUTH_TOKEN` | Sí | Auth Token de la cuenta de Twilio (firma y token del stream) |
| `N8N_AUTH_VALUE` (`N8N_AUTH_HEADER`) | Sí | Secreto de los webhooks de n8n (cabecera `X-Hospitia-Token` por defecto) |
| `CLIENTES_JSON` o `CLIENTES_FILE` | Sí | Configuración de cada cliente por número. **Nunca en el repositorio**: variable de entorno o *Secret File* de Render. Formato en `clientes.example.json` |
| `MAX_CALL_SECONDS` | No | Duración máxima de la llamada (600 por defecto) |

En Twilio, el número del cliente apunta su webhook de voz («A call comes in») a `POST {PUBLIC_URL}/twilio/voice`.

### Pruebas

`npm install && npm test`
