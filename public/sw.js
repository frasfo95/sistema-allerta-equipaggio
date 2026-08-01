// Service Worker - gestisce le notifiche push anche quando l'app è chiusa

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Piccolo magazzino locale (IndexedDB) per ricordare, anche se il Service Worker si riavvia,
// a quale membro appartiene questo dispositivo — serve solo per il rinnovo automatico qui sotto.
function idbGetMemberId() {
  return new Promise((resolve) => {
    const req = indexedDB.open('soccorso-mare', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => {
      const tx = req.result.transaction('kv', 'readonly');
      const getReq = tx.objectStore('kv').get('memberId');
      getReq.onsuccess = () => resolve(getReq.result || null);
      getReq.onerror = () => resolve(null);
    };
    req.onerror = () => resolve(null);
  });
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map(c => c.charCodeAt(0)));
}

// I telefoni, periodicamente, invalidano e rinnovano da soli la sottoscrizione alle notifiche:
// senza questo gestore, quel telefono smetterebbe silenziosamente di ricevere gli allarmi.
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    try {
      const memberId = await idbGetMemberId();
      if (!memberId) return; // nessun account collegato a questo dispositivo al momento
      const { publicKey } = await fetch('/api/vapid-public-key').then(r => r.json());
      const newSubscription = await self.registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
      await fetch('/api/register', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ memberId, subscription: newSubscription })
      });
    } catch (e) {
      // Se il rinnovo automatico fallisce, verrà comunque ritentato alla prossima apertura dell'app
    }
  })());
});

self.addEventListener('push', (event) => {
  let data = { title: 'Allerta', body: 'Nuova comunicazione', vibrate: [300], urgency: 'preallerta' };
  try {
    data = event.data.json();
  } catch (e) {
    // payload non in formato JSON, uso i valori di default
  }

  const isIntervento = data.urgency === 'intervento';

  const options = {
    body: data.body,
    vibrate: data.vibrate || [300, 100, 300],
    tag: 'soccorso-mare-alert', // sostituisce notifiche precedenti dello stesso tipo di evento
    renotify: true,
    requireInteraction: true, // resta visibile finché non viene toccata
    silent: false, // usa il suono di notifica di sistema
    data: { urgency: data.urgency, timestamp: Date.now() },
    icon: isIntervento ? '/icon-intervento.png' : '/icon-preallerta.png',
    badge: '/icon-badge.png'
  };

  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title, options),
      self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
        clientList.forEach((client) => client.postMessage({ type: 'ALERT', data }));
      })
    ])
  );
});

// Al tocco della notifica, apre (o porta in primo piano) la pagina equipaggio
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('crew.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/crew.html');
      }
    })
  );
});
