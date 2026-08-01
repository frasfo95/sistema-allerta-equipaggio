require('dotenv').config();
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const webpush = require('web-push');
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
  subscription: { type: Object, default: null },
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
  acked: [{ memberId: String, name: String, at: { type: Date, default: Date.now } }]
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

  const alert = await Alert.create({
    type,
    title: text.title,
    body: text.body,
    recipients: inServizio.map(m => ({ memberId: m.memberId, name: m.name }))
  });

  if (inServizio.length === 0) {
    return res.json({ ok: true, alertId: alert._id, sent: 0, warning: 'Nessun membro in servizio (check-in) al momento.' });
  }

  const payload = JSON.stringify({
    alertId: alert._id.toString(),
    title: text.title,
    body: text.body,
    vibrate: text.vibrate,
    urgency: type
  });
  const pushOptions = { urgency: type === 'intervento' ? 'high' : 'normal', TTL: 3600 };

  const results = await Promise.allSettled(
    inServizio.map(m =>
      webpush.sendNotification(m.subscription, payload, pushOptions).catch(err => {
        if (err.statusCode === 404 || err.statusCode === 410) {
          // La sottoscrizione non è più valida (es. app disinstallata): la rimuoviamo per non
          // riprovare inutilmente ad ogni prossimo allarme, così l'invio resta rapido nel tempo.
          Member.deleteOne({ memberId: m.memberId }).catch(() => {});
        }
        throw err;
      })
    )
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  res.json({ ok: true, alertId: alert._id, sent, failed: results.length - sent, totalInServizio: inServizio.length });
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
