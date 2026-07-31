# Eduba-Board - Proje Yapısı

Eduba-Board, kullanıcıların organizasyonlar ve projeler oluşturup Kanban panoları ve Yjs + WebSocket tabanlı gerçek zamanlı etkileşimli çizim tahtaları üzerinde iş birliği yapmasını sağlayan modern bir web uygulamasıdır.

## Mimari ve Teknolojiler

- **Backend**: Node.js & Fastify (Sunucu & REST API & WebSockets)
- **Veritabanı**: Yerel SQLite (`better-sqlite3`) (`sqlite.db`)
- **Gerçek Zamanlı Çizim Tahtası & Birlikte Çalışma**: Yjs (`yjs`) & `y-websocket`
- **Kullanıcı Şifreleme**: `bcrypt`
- **Frontend**: Vanilla HTML5, CSS3, JavaScript (ES6+), Lucide Icons

---

## Dizin ve Dosya Yapısı

```
Eduba-Board/
├── index.js              # Sunucu başlangıç noktası (Fastify, static yönlendirme, modül kayıtları)
├── cli.js                # Komut satırı yönetim aracı (kullanıcı kaydı ve girişi testleri)
├── install.js            # Veritabanı şemasını sıfırdan kurma scripti
├── package.json          # Proje bağımlılıkları ve npm scriptleri
├── sqlite.db             # Yerel SQLite veritabanı dosyası
├── PROJECT_STRUCTURE.md  # Proje mimarisi ve yapı dokümantasyonu
│
├── modules/              # Backend Modülleri & Veritabanı Katmanı
│   ├── db.js             # SQLite (better-sqlite3) bağlantısı, Postgres uyumluluk fonksiyonları ve şema yönetimi
│   ├── auth.js           # Kullanıcı kaydı, girişi, çıkışı ve oturum doğrulama kancaları
│   ├── boards.js         # Dashboard, projeler, organizasyonlar (gruplar), davetler ve üyelik REST API'leri
│   ├── ws.js             # Yjs gerçek zamanlı ortak çizim tahtası WebSocket işleyicisi ve DB kalıcılığı
│   └── route.js          # Rota tanımlama yardımcıları
│
└── public/               # Frontend Sayfaları & İstemci Varlıkları
    ├── login.html        # Kullanıcı giriş ve kayıt ekranı (Glassmorphism tasarım)
    ├── dashboard.html    # Organizasyonlar, projeler ve davetler yönetim paneli
    └── board.html        # Gerçek zamanlı etkileşimli çizim tahtası, Kanban (Yapılacaklar) panosu ve araç çubuğu
```

---

## Ana Modüllerin Sorumlulukları

1. **Veritabanı Katmanı (`modules/db.js`)**:
   - `sqlite.db` veritabanı dosyasını bağlar.
   - `$1, $2` PostgreSQL sorgu parametrelerini SQLite uyumlu biçime dönüştürür.
   - `gen_random_uuid()`, `now()`, `btrim()`, `split_part()` gibi özel SQL fonksiyonlarını destekler.
   - `users`, `sessions`, `groups`, `group_members`, `projects`, `board_docs`, `invitations` tablolarını oluşturur.

2. **Kimlik Doğrulama (`modules/auth.js`)**:
   - `/api/auth/register`: Yeni kullanıcı kaydı.
   - `/api/auth/login`: Oturum oluşturma (HTTP-Only Cookie).
   - `/api/auth/logout`: Oturum sonlandırma.
   - Oturum çerezlerini doğrulayan `preHandler` kancası.

3. **Organizasyon ve Proje Yönetimi (`modules/boards.js`)**:
   - `/api/boards/dashboard`: Kullanıcının projelerini, dahil olduğu organizasyonları ve gruptaki projeleri getirir.
   - `/api/boards/groups`: Yeni organizasyon oluşturma ve yönetme.
   - `/api/boards/projects/move`: Projeleri organizasyonlar ve kişisel alan arasında taşıma.
   - `/api/boards/invite` & `/api/boards/invitations`: E-posta ile organizasyona davet gönderme ve davet yanıtlama.

4. **Çizim Tahtası ve Gerçek Zamanlı Ortak Çalışma (`modules/ws.js` & `public/board.html`)**:
   - WebSocket (`/ws/:room`) üzerinden Yjs Y.Doc durumunu senkronize eder.
   - Değişiklikleri otomatik olarak veritabanındaki `board_docs` tablosuna `doc_data` (BLOB) olarak kaydeder.
   - Katılımcıların fare konumlarını (Awareness) diğer tüm bağlı kullanıcılara canlı yansıtır.
   - Sol taraftaki Kanban (Yapılacaklar / Devam Edenler / Tamamlananlar) görevlerini tahtayla senkronize tutar.
