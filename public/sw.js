// Service Worker - gestisce le notifiche push anche quando l'app è chiusa

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
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
