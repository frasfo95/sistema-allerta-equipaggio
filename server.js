require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const webpush = require('web-push');
const admin = require('firebase-admin');
const mongoose = require('mongoose');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// --- Connessione al database MongoDB ---
const MONGODB_URI = process.env.MONGODB_URI;
if (!MONGODB_URI) {
  console.error('\n⚠️  Manca la variabile MONGODB_URI. Configurala su Render (vedi guida).\n');
  process.exit(1);
}
mongoose.connect(MONGODB_URI, {
  serverSelectionTimeoutMS: 8000 // se il database non risponde, fallisce in fretta invece di restare bloccato
})
  .then(() => console.log('Connesso al database MongoDB'))
  .catch(err => {
    console.error('Errore di connessione al database:', err.message);
    process.exit(1);
  });

// Se la connessione cade dopo l'avvio (es. problema di rete temporaneo), lo segnaliamo nei log
// invece di lasciare il server in uno stato ambiguo; mongoose riprova a riconnettersi da solo.
mongoose.connection.on('error', (err) => console.error('Errore di connessione MongoDB:', err.message));
mongoose.connection.on('disconnected', () => console.warn('Disconnesso da MongoDB, tento la riconnessione automatica...'));
mongoose.connection.on('reconnected', () => console.log('Riconnesso a MongoDB'));

// --- Modelli dati ---
const memberSchema = new mongoose.Schema({
  memberId: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  code: { type: String, unique: true, required: true }, // codice personale a 4 cifre
  subscription: { type: Object, default: null }, // notifiche push da browser/PWA (usate su iPhone e Android via sito)
  fcmToken: { type: String, default: null },      // notifiche native Android (app vera, tramite Firebase)
  checkedIn: { type: Boolean, default: false },
  lastUpdate: { type: Date, default: Date.now }
});
const Member = mongoose.model('Member', memberSchema);

const alertSchema = new mongoose.Schema({
  type: { type: String, enum: ['preallerta', 'intervento'], required: true },
  title: String,
  body: String,
  createdAt: { type: Date, default: Date.now },
  recipients: [{ memberId: String, name: String }],
  acked: [{ memberId: String, name: String, at: { type: Date, default: Date.now } }],
  seen: [{ memberId: String, at: { type: Date, default: Date.now } }] // ha aperto la schermata, ma non ha ancora premuto "Ho ricevuto"
});
alertSchema.index({ createdAt: -1 }); // le query "ultimo allarme" restano veloci anche con uno storico lungo
const Alert = mongoose.model('Alert', alertSchema);

// --- Configurazione VAPID ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.org';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('\n⚠️  Mancano le chiavi VAPID. Vedi la guida per configurarle su Render.\n');
  process.exit(1);
}
webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// --- Configurazione Firebase (per le notifiche dell'app Android nativa) ---
// Facoltativa: se non ancora configurata, il sistema continua a funzionare normalmente
// per il sito/PWA (comandante e pagina equipaggio via browser, su iPhone e Android);
// semplicemente l'app nativa Android non riceverà notifiche finché non si imposta questa variabile.
let firebaseMessaging = null;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
    firebaseMessaging = admin.messaging();
    console.log('Firebase Cloud Messaging attivo (app Android nativa abilitata)');
  } catch (e) {
    console.error('⚠️  FIREBASE_SERVICE_ACCOUNT presente ma non valida:', e.message);
  }
} else {
  console.log('Firebase non configurato: le notifiche dell\'app nativa Android sono disattivate per ora (il sito/PWA funziona regolarmente).');
}

// --- Middleware ---
app.use(cors());
app.use(compression()); // risposte più leggere e veloci da scaricare, soprattutto su rete mobile
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  maxAge: '1h' // le icone/manifest possono restare in cache sul telefono, il sito si carica più in fretta
}));

// Evita che un errore in una singola richiesta (es. il database che risponde con un intoppo)
// blocchi la richiesta all'infinito o mandi in crash il server: qualsiasi eccezione finisce
// gestita in modo pulito dal middleware di errore in fondo al file.
function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

function isValidObjectId(id) {
  return mongoose.Types.ObjectId.isValid(id);
}

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Crea un nuovo membro dell'equipaggio con il codice a 4 cifre fornito direttamente
app.post('/api/member/new', asyncHandler(async (req, res) => {
  const { name, code } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Il nome è obbligatorio' });
  }
  if (!/^\d{4}$/.test(String(code || '').trim())) {
    return res.status(400).json({ error: 'Il codice deve essere di 4 cifre' });
  }
  const cleanCode = String(code).trim();
  const memberId = new mongoose.Types.ObjectId().toString();
  try {
    await Member.create({ memberId, name: name.trim(), code: cleanCode });
  } catch (e) {
    // Codice 11000 = valore duplicato: gestisce anche il rarissimo caso di due registrazioni
    // arrivate nello stesso istante con lo stesso codice, non solo il controllo preventivo.
    if (e.code === 11000) {
      return res.status(409).json({ error: 'Questo codice è già in uso da un altro membro. Sceglietene uno diverso.' });
    }
    throw e;
  }
  res.json({ ok: true, memberId, code: cleanCode, name: name.trim() });
}));

// Ritrova un membro già registrato tramite il suo codice a 4 cifre (es. da un nuovo telefono)
app.post('/api/member/lookup', asyncHandler(async (req, res) => {
  const { code } = req.body;
  if (!/^\d{4}$/.test(String(code || '').trim())) {
    return res.status(400).json({ error: 'Il codice deve essere di 4 cifre' });
  }
  const member = await Member.findOne({ code: String(code).trim() });
  if (!member) return res.status(404).json({ error: 'Nessun membro trovato con questo codice' });
  res.json({ ok: true, memberId: member.memberId, name: member.name, code: member.code });
}));

// Collega (o aggiorna) la sottoscrizione alle notifiche push per un membro già esistente
app.post('/api/register', asyncHandler(async (req, res) => {
  const { memberId, subscription } = req.body;
  if (!memberId || !subscription) {
    return res.status(400).json({ error: 'memberId e subscription sono obbligatori' });
  }
  const member = await Member.findOneAndUpdate(
    { memberId },
    { subscription, lastUpdate: new Date() },
    { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ ok: true });
}));

// Collega (o aggiorna) il token dell'app Android nativa per un membro già esistente
app.post('/api/register-fcm', asyncHandler(async (req, res) => {
  const { memberId, fcmToken } = req.body;
  if (!memberId || !fcmToken) {
    return res.status(400).json({ error: 'memberId e fcmToken sono obbligatori' });
  }
  const member = await Member.findOneAndUpdate(
    { memberId },
    { fcmToken, lastUpdate: new Date() },
    { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ ok: true });
}));

app.post('/api/checkin', asyncHandler(async (req, res) => {
  const { memberId } = req.body;
  const member = await Member.findOneAndUpdate(
    { memberId }, { checkedIn: true, lastUpdate: new Date() }, { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  res.json({ ok: true, checkedIn: true });
}));

app.post('/api/checkout', asyncHandler(async (req, res) => {
  const { memberId } = req.body;
  const member = await Member.findOneAndUpdate(
    { memberId }, { checkedIn: false, lastUpdate: new Date() }, { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  res.json({ ok: true, checkedIn: false });
}));

app.delete('/api/crew/:memberId', asyncHandler(async (req, res) => {
  const result = await Member.deleteOne({ memberId: req.params.memberId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ ok: true });
}));

app.get('/api/crew/status', asyncHandler(async (req, res) => {
  const members = await Member.find({}, 'memberId name checkedIn lastUpdate').lean();
  res.json({
    members: members.map(m => ({
      memberId: m.memberId, name: m.name, checkedIn: m.checkedIn, lastUpdate: m.lastUpdate
    }))
  });
}));

// Invia una "raffica" di notifiche (push da browser + Firebase) a un gruppo di membri,
// tutte riferite allo stesso allarme (stesso alertId): usata sia per il primo invio
// immediato sia per i richiami automatici successivi.
async function deliverAlertPush(members, alertId, text, type) {
  const payload = JSON.stringify({
    alertId: alertId.toString(),
    title: text.title,
    body: text.body,
    vibrate: text.vibrate,
    urgency: type
  });
  const pushOptions = { urgency: type === 'intervento' ? 'high' : 'normal', TTL: 3600 };

  const withWebPush = members.filter(m => m.subscription);
  const webResults = await Promise.allSettled(
    withWebPush.map(m =>
      webpush.sendNotification(m.subscription, payload, pushOptions).catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          Member.updateOne({ memberId: m.memberId }, { subscription: null }).catch(() => {});
        }
        throw err;
      })
    )
  );
  const sent = webResults.filter(r => r.status === 'fulfilled').length;

  let fcmSent = 0;
  if (firebaseMessaging) {
    const withFcm = members.filter(m => m.fcmToken);
    const fcmResults = await Promise.allSettled(
      withFcm.map(m =>
        firebaseMessaging.send({
          token: m.fcmToken,
          android: { priority: 'high' },
          data: { alertId: alertId.toString(), title: text.title, body: text.body, urgency: type }
        }).catch(err => {
          if (err.code === 'messaging/registration-token-not-registered') {
            Member.updateOne({ memberId: m.memberId }, { fcmToken: null }).catch(() => {});
          }
          throw err;
        })
      )
    );
    fcmSent = fcmResults.filter(r => r.status === 'fulfilled').length;
  }

  return { sent, fcmSent, failed: webResults.length - sent };
}

// Dopo l'invio iniziale, ripete lo stesso allarme (stesso alertId, quindi conteggiato come
// UN SOLO evento ai fini della conferma "Ho ricevuto") ogni 2 secondi, fino a un massimo di
// 15 volte in totale — serve a rendere il suono più insistente e affidabile sul telefono di
// chi lo riceve. Ad ogni giro, chi ha già confermato la ricezione smette di essere ricontattato.
function scheduleRepeatedDelivery(alertId, text, type, initialRecipientIds) {
  const MAX_ROUNDS = 15;
  const INTERVAL_MS = 2000;
  let round = 1; // il round 1 è già stato inviato prima di chiamare questa funzione

  const timer = setInterval(async () => {
    round++;
    if (round > MAX_ROUNDS) { clearInterval(timer); return; }
    try {
      const alert = await Alert.findById(alertId).lean();
      if (!alert) { clearInterval(timer); return; }
      const doneIds = new Set([
        ...alert.acked.map(a => a.memberId),
        ...alert.seen.map(s => s.memberId)
      ]);
      const stillWaiting = initialRecipientIds.filter(id => !doneIds.has(id));
      if (stillWaiting.length === 0) { clearInterval(timer); return; } // tutti hanno visto o confermato: si ferma da sola

      const freshMembers = await Member.find({ memberId: { $in: stillWaiting }, checkedIn: true }).lean();
      if (freshMembers.length > 0) {
        await deliverAlertPush(freshMembers, alertId, text, type);
      }
    } catch (e) {
      console.error('Errore nel richiamo automatico dell\'allarme:', e.message);
    }
  }, INTERVAL_MS);
}

app.post('/api/alert', asyncHandler(async (req, res) => {
  const { type } = req.body;
  if (!['preallerta', 'intervento'].includes(type)) {
    return res.status(400).json({ error: "type deve essere 'preallerta' o 'intervento'" });
  }

  const texts = {
    preallerta: { title: '⚠️ PRE-ALLERTA', body: 'Il comandante ha lanciato una pre-allerta. Tenersi pronti.', vibrate: [300, 100, 300] },
    intervento: { title: '🚨 INTERVENTO', body: 'CHIAMATA PER INTERVENTO. Presentarsi immediatamente.', vibrate: [500, 150, 500, 150, 500, 150, 500] }
  };
  const text = texts[type];

  const inServizio = await Member.find({ checkedIn: true }).lean();

  // Un solo documento allarme: tutte le notifiche ripetute che seguono fanno riferimento
  // a questo stesso alertId, quindi per il comandante resta un evento unico da confermare.
  const alert = await Alert.create({
    type,
    title: text.title,
    body: text.body,
    recipients: inServizio.map(m => ({ memberId: m.memberId, name: m.name }))
  });

  if (inServizio.length === 0) {
    return res.json({ ok: true, alertId: alert._id, sent: 0, warning: 'Nessun membro in servizio (check-in) al momento.' });
  }

  const { sent, fcmSent, failed } = await deliverAlertPush(inServizio, alert._id, text, type);

  // Da qui in avanti il primo invio è già partito: i richiami successivi proseguono in
  // background, senza far attendere il comandante che ha già ricevuto conferma dell'invio.
  scheduleRepeatedDelivery(alert._id, text, type, inServizio.map(m => m.memberId));

  res.json({ ok: true, alertId: alert._id, sent, fcmSent, failed, totalInServizio: inServizio.length });
}));

app.post('/api/alert/:id/ack', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Allarme non valido' });
  const { memberId, name } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId obbligatorio' });

  const alert = await Alert.findById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Allarme non trovato' });

  if (!alert.acked.some(a => a.memberId === memberId)) {
    alert.acked.push({ memberId, name: name || memberId, at: new Date() });
    await alert.save();
  }
  res.json({ ok: true });
}));

// Segnala che il membro ha aperto la schermata dell'allarme: basta questo a fermare i richiami
// automatici (la raffica ogni 2 secondi), anche prima che prema "Ho ricevuto". Non conta come
// conferma di ricezione per il comandante: quella resta legata solo all'endpoint /ack qui sopra.
app.post('/api/alert/:id/seen', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Allarme non valido' });
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId obbligatorio' });

  const alert = await Alert.findById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Allarme non trovato' });

  if (!alert.seen.some(s => s.memberId === memberId)) {
    alert.seen.push({ memberId, at: new Date() });
    await alert.save();
  }
  res.json({ ok: true });
}));

app.get('/api/alert/latest', asyncHandler(async (req, res) => {
  const alert = await Alert.findOne().sort({ createdAt: -1 }).lean();
  res.json({ alert: alert || null });
}));

app.get('/api/alert/:id', asyncHandler(async (req, res) => {
  if (!isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Allarme non valido' });
  const alert = await Alert.findById(req.params.id).lean();
  if (!alert) return res.status(404).json({ error: 'Allarme non trovato' });
  res.json({ alert });
}));

// Rotta non trovata (qualsiasi /api/... non riconosciuto)
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Rotta non trovata' });
});

// Gestore centrale degli errori: qualunque eccezione nelle rotte sopra finisce qui,
// invece di far restare il telefono in attesa o mostrare una pagina di errore grezza.
app.use((err, req, res, next) => {
  console.error('Errore non gestito:', err);
  res.status(500).json({ error: 'Errore interno del server. Riprova tra qualche istante.' });
});

app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
