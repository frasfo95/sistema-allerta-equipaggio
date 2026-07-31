require('dotenv').config();
const express = require('express');
const cors = require('cors');
const webpush = require('web-push');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DATA_FILE = path.join(__dirname, 'data.json');

// --- Configurazione VAPID (necessaria per le Web Push) ---
const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@example.org';

if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) {
  console.error('\n⚠️  Mancano le chiavi VAPID. Esegui: npm run generate-vapid');
  console.error('   e copia le chiavi generate nel file .env (vedi .env.example)\n');
  process.exit(1);
}

webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);

// --- Persistenza semplice su file JSON (adatta a equipaggi piccoli, <10 persone) ---
function loadData() {
  if (!fs.existsSync(DATA_FILE)) {
    return { members: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (e) {
    console.error('Errore lettura data.json, riparto da zero:', e.message);
    return { members: {} };
  }
}

function saveData(data) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
}

let db = loadData();

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Espone la chiave pubblica VAPID al client (serve per sottoscrivere il push)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ publicKey: VAPID_PUBLIC_KEY });
});

// Registra o aggiorna la sottoscrizione push di un membro dell'equipaggio
app.post('/api/register', (req, res) => {
  const { memberId, name, subscription } = req.body;
  if (!memberId || !subscription) {
    return res.status(400).json({ error: 'memberId e subscription sono obbligatori' });
  }
  db.members[memberId] = {
    name: name || memberId,
    subscription,
    checkedIn: db.members[memberId]?.checkedIn || false,
    lastUpdate: new Date().toISOString()
  };
  saveData(db);
  res.json({ ok: true });
});

// Check-in: inizio turno, da questo momento riceve le allerte
app.post('/api/checkin', (req, res) => {
  const { memberId } = req.body;
  if (!memberId || !db.members[memberId]) {
    return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  }
  db.members[memberId].checkedIn = true;
  db.members[memberId].lastUpdate = new Date().toISOString();
  saveData(db);
  res.json({ ok: true, checkedIn: true });
});

// Check-out: fine turno, non riceve più le allerte
app.post('/api/checkout', (req, res) => {
  const { memberId } = req.body;
  if (!memberId || !db.members[memberId]) {
    return res.status(404).json({ error: 'Membro non registrato. Ricarica la pagina.' });
  }
  db.members[memberId].checkedIn = false;
  db.members[memberId].lastUpdate = new Date().toISOString();
  saveData(db);
  res.json({ ok: true, checkedIn: false });
});

// Stato equipaggio (per la dashboard del comandante)
app.get('/api/crew/status', (req, res) => {
  const list = Object.entries(db.members).map(([memberId, m]) => ({
    memberId,
    name: m.name,
    checkedIn: m.checkedIn,
    lastUpdate: m.lastUpdate
  }));
  res.json({ members: list });
});

// Invio allerta: il comandante preme PRE-ALLERTA o INTERVENTO
app.post('/api/alert', async (req, res) => {
  const { type } = req.body; // 'preallerta' | 'intervento'
  if (!['preallerta', 'intervento'].includes(type)) {
    return res.status(400).json({ error: "type deve essere 'preallerta' o 'intervento'" });
  }

  const payloads = {
    preallerta: {
      title: '⚠️ PRE-ALLERTA',
      body: 'Il comandante ha lanciato una pre-allerta. Tenersi pronti.',
      vibrate: [300, 100, 300],
      urgency: 'preallerta'
    },
    intervento: {
      title: '🚨 INTERVENTO',
      body: 'CHIAMATA PER INTERVENTO. Presentarsi immediatamente.',
      vibrate: [500, 150, 500, 150, 500, 150, 500],
      urgency: 'intervento'
    }
  };

  const payload = JSON.stringify(payloads[type]);

  const recipients = Object.entries(db.members).filter(([, m]) => m.checkedIn);

  if (recipients.length === 0) {
    return res.json({ ok: true, sent: 0, warning: 'Nessun membro in servizio (check-in) al momento.' });
  }

  const results = await Promise.allSettled(
    recipients.map(([memberId, m]) =>
      webpush.sendNotification(m.subscription, payload).catch(err => {
        // Sottoscrizione scaduta o non più valida: la rimuoviamo
        if (err.statusCode === 404 || err.statusCode === 410) {
          delete db.members[memberId];
        }
        throw err;
      })
    )
  );

  saveData(db);

  const sent = results.filter(r => r.status === 'fulfilled').length;
  const failed = results.length - sent;

  res.json({ ok: true, sent, failed, totalInServizio: recipients.length });
});

app.listen(PORT, () => {
  console.log(`Server avviato sulla porta ${PORT}`);
});
