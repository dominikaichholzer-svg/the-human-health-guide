// sw.js
//
// Service Worker fürs Leader-Dashboard. Zeigt eingehende Push-Nachrichten
// als Browser-Benachrichtigung an. Muss im Root liegen, damit der Scope
// die ganze Seite abdeckt (Service Worker können Unterverzeichnisse nicht
// von oberhalb ihres eigenen Pfads kontrollieren).

self.addEventListener('push', function (event) {
  let data = { title: 'Coach Oaki Team', body: 'Neue Nachricht' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // Fallback falls der Payload mal kein JSON ist
    data = { title: 'Coach Oaki Team', body: event.data ? event.data.text() : '' };
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'Coach Oaki Team', {
      body: data.body || '',
      icon: data.icon || undefined,
      badge: data.badge || undefined,
      data: { url: data.url || '/' },
    })
  );
});

self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    clients.matchAll({ type: 'window' }).then(function (windowClients) {
      for (const client of windowClients) {
        if (client.url === url && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});
