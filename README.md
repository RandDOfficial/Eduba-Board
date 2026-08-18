# Eduba Board

Gerçek zamanlı iş birliği, görsel tahta ve Kanban tabanlı proje yönetim platformu. Ekiplerin veya bireysel kullanıcıların serbest kanvas üzerinde fikirlerini görselleştirmesini, notlar almasını ve görevlerini yönetmesini sağlar.

---

## Öne Çıkan Özellikler

- **Gerçek Zamanlı Çizim ve Kanvas**: WebSocket tabanlı anlık imleç ve nesne senkronizasyonu ile aynı anda ortak çalışma.
- **Entegre Kanban Panosu**: Tahta içinde görev yönetimi (Yapılacaklar, Devam Edenler, Tamamlananlar).
- **Organizasyon ve Proje Yönetimi**: Ekipler, kişisel projeler ve e-posta ile davet sistemi.
- **Evrensel Veritabanı Desteği**: Sıfır yapılandırmayla yerel SQLite veya yüksek ölçek için PostgreSQL.
- **Otomatik Yedekleme & Kalıcılık**: SQLite veritabanı için zamanlanmış otomatik yedekleme ve rotasyon.
- **Gizlilik Odaklı**: Tüm verileriniz kendi sunucunuzda veya container ortamınızda kalır.

---

## Kurulum ve Dağıtım (Docker)

Eduba Board, resmi GitHub Container Registry (`ghcr.io`) imajı üzerinden doğrudan çalıştırılabilir.

### 1. Hızlı Başlangıç (Yerel SQLite ile)

Aşağıdaki `docker-compose.yml` dosyasını oluşturun ve çalıştırın:

```yaml
services:
  eduba:
    image: ghcr.io/randdofficial/eduba-board:latest
    container_name: eduba-app
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - ALLOW_REGISTRATION=true
      - BACKUP_INTERVAL_HOURS=48
      - MAX_BACKUPS=5
    volumes:
      - ./data:/app/data
```

Container'ı başlatın:
```bash
docker compose up -d
```
Tarayıcınızdan `http://localhost:3000` adresine gidin.

---

### 2. PostgreSQL ile Üretim (Production) Kurulumu

Daha yüksek kullanıcı kapasitesi ve harici veritabanı yönetimi için Eduba'yı PostgreSQL ile birlikte çalıştırabilirsiniz:

```yaml
services:
  eduba:
    image: ghcr.io/randdofficial/eduba-board:latest
    container_name: eduba-app
    restart: unless-stopped
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://postgres:securepassword@postgres:5432/edubadb
      - ALLOW_REGISTRATION=true
    depends_on:
      - postgres

  postgres:
    image: postgres:16-alpine
    container_name: eduba-db
    restart: unless-stopped
    environment:
      POSTGRES_DB: edubadb
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: securepassword
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## Ortam Değişkenleri (Environment Variables)

| Değişken | Varsayılan | Açıklama |
| :--- | :--- | :--- |
| `PORT` | `3000` | Sunucunun dinleyeceği port |
| `NODE_ENV` | `development` | Çalışma ortamı (`production` veya `development`) |
| `ALLOW_REGISTRATION` | `true` | Yeni kullanıcı kayıtlarına izin verilsin mi (`true`/`false`) |
| `DATABASE_URL` | *(Boş)* | PostgreSQL bağlantı adresi (Belirtilmezse SQLite kullanılır) |
| `DB_PATH` | `/app/data/sqlite.db` | SQLite veritabanı dosyasının konumu |
| `BACKUP_INTERVAL_HOURS` | `48` | SQLite otomatik yedekleme periyodu (Saat cinsinden) |
| `MAX_BACKUPS` | `5` | Saklanacak maksimum geçmiş yedek sayısı |

---

## Veri Yedekleme ve Kalıcılık

- **SQLite Modunda**: `./data` dizini container'a bağlanarak veriler korunur. Sistem her 48 saatte bir (veya belirlenen aralıkta) `./data/backups/` içerisine otomatik SQLite yedeği alır ve eski yedekleri temizler.
- **PostgreSQL Modunda**: Veriler `pgdata` volume'ünde saklanır. Yedeklemeler standart PostgreSQL araçlarıyla (`pg_dump`) veya bulut veritabanı anlık görüntüleriyle yönetilir.
