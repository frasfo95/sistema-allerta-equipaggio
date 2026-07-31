// Esegui una sola volta con: node generate-vapid.js
// Copia le due chiavi stampate nel file .env (vedi .env.example)
const webpush = require('web-push');

const keys = webpush.generateVAPIDKeys();

console.log('\n=== Chiavi VAPID generate ===\n');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
console.log('\nCopia queste due righe nel file .env del backend.');
console.log('La chiave pubblica va anche in public/config.js (viene fatto in automatico da server.js, nessuna azione manuale richiesta).\n');
