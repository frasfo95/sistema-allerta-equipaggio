require('dotenv').config();
const express = require('express');
const cors = require('cors');
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
mongoose.connect(MONGODB_URI)
  .then(() => console.log('Connesso al database MongoDB'))
  .catch(err => {
    console.error('Errore di connessione al database:', err.message);
    process.exit(1);
  });

// --- Modelli dati ---
const memberSchema = new mongoose.Schema({
  memberId: { type: String, unique: true, required: true },
  name: { type: String, required: true },
  subscription: { type: Object, required: true },
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
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

app.post('/api/register', async (req, res) => {
  const { memberId, name, subscription } = req.body;
  if (!memberId || !subscription) {
    return res.status(400).json({ error: 'memberId e subscription sono obbligatori' });
  }
  await Member.findOneAndUpdate(
    { memberId },
    { memberId, name: name || memberId, subscription, lastUpdate: new Date() },
    { upsert: true, setDefaultsOnInsert: true }
  );
  res.json({ ok: true });
});

app.post('/api/checkin', async (req, res) => {
  const { memberId } = req.body;
  const member = await Member.findOneAndUpdate(
    { memberId }, { checkedIn: true, lastUpdate: new Date() }, { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  res.json({ ok: true, checkedIn: true });
});

app.post('/api/checkout', async (req, res) => {
  const { memberId } = req.body;
  const member = await Member.findOneAndUpdate(
    { memberId }, { checkedIn: false, lastUpdate: new Date() }, { new: true }
  );
  if (!member) return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  res.json({ ok: true, checkedIn: false });
});

app.delete('/api/crew/:memberId', async (req, res) => {
  const result = await Member.deleteOne({ memberId: req.params.memberId });
  if (result.deletedCount === 0) return res.status(404).json({ error: 'Membro non trovato' });
  res.json({ ok: true });
});

app.get('/api/crew/status', async (req, res) => {
  const members = await Member.find({}, 'memberId name checkedIn lastUpdate').lean();
  res.json({
    members: members.map(m => ({
      memberId: m.memberId, name: m.name, checkedIn: m.checkedIn, lastUpdate: m.lastUpdate
    }))
  });
});

app.post('/api/alert', async (req, res) => {
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
          Member.deleteOne({ memberId: m.memberId }).catch(() => {});
        }
        throw err;
      })
    )
  );

  const sent = results.filter(r => r.status === 'fulfilled').length;
  res.json({ ok: true, alertId: alert._id, sent, failed: results.length - sent, totalInServizio: inServizio.length });
});

app.post('/api/alert/:id/ack', async (req, res) => {
  const { memberId, name } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId obbligatorio' });

  const alert = await Alert.findById(req.params.id);
  if (!alert) return res.status(404).json({ error: 'Allarme non trovato' });

  if (!alert.acked.some(a => a.memberId === memberId)) {
    alert.acked.push({ memberId, name: name || memberId, at: new Date() });
    await alert.save();
  }
  res.json({ ok: true });
});

app.get('/api/alert/latest', async (req, res) => {
  const alert = await Alert.findOne().sort({ createdAt: -1 }).lean();
  res.json({ alert: alert || null });
});

app.get('/api/alert/:id', async (req, res) => {
  const alert = await Alert.findById(req.params.id).lean();
  if (!alert) return res.status(404).json({ error: 'Allarme non trovato' });
  res.json({ alert });
});

app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
