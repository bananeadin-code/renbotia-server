/**
 * Suscribe TU app a la WABA (WhatsApp Business Account) para que Meta ENTREGUE
 * los webhooks de mensajes entrantes al servidor.
 *
 * Aunque el webhook esté verificado y el campo "messages" suscrito a nivel de la
 * app, Meta NO envía los mensajes de una WABA hasta que la app está suscrita a
 * ESA cuenta. Esta llamada (POST /{WABA_ID}/subscribed_apps) cierra ese hueco.
 *
 * Uso (Shell de Render, con WHATSAPP_TOKEN en el entorno):
 *   node scripts/subscribe-whatsapp.mjs "<WABA_ID>"
 * Si no pasas el WABA_ID, usa WHATSAPP_WABA_ID del entorno.
 */
const wabaId = process.argv[2] || process.env.WHATSAPP_WABA_ID;
const token = process.env.WHATSAPP_TOKEN;
const version = process.env.WHATSAPP_API_VERSION || 'v21.0';

if (!token) {
  console.error('\n❌ Falta WHATSAPP_TOKEN en el entorno.\n');
  process.exit(1);
}
if (!wabaId) {
  console.error('\n❌ Falta el WABA_ID. Pásalo como argumento: node scripts/subscribe-whatsapp.mjs "<WABA_ID>"\n');
  process.exit(1);
}

const base = `https://graph.facebook.com/${version}/${wabaId}/subscribed_apps`;

async function main() {
  // 1) Suscribir la app a la WABA.
  const postRes = await fetch(base, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
  const postBody = await postRes.json().catch(() => ({}));
  console.log(`\nPOST subscribed_apps → HTTP ${postRes.status}`);
  console.log(JSON.stringify(postBody, null, 2));

  // 2) Confirmar qué apps quedaron suscritas a esa WABA.
  const getRes = await fetch(base, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const getBody = await getRes.json().catch(() => ({}));
  console.log(`\nGET subscribed_apps → HTTP ${getRes.status}`);
  console.log(JSON.stringify(getBody, null, 2));

  if (postRes.ok && postBody.success) {
    console.log('\n✅ App suscrita a la WABA. Ya deberían llegar los webhooks de mensajes.\n');
  } else {
    console.log('\n⚠️ No se confirmó la suscripción. Revisa el token (permiso whatsapp_business_management) y el WABA_ID.\n');
  }
}

main().catch((err) => {
  console.error('\n❌ Error:', err.message, '\n');
  process.exit(1);
});
