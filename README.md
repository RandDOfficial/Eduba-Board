# Eduba Board

Gerçek zamanlı görsel planlama, çizim tahtası ve Kanban yönetim uygulaması.

---

## Kurulum (Docker Compose)

### 1. SQLite ile Çalıştırma (Varsayılan)

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

```bash
docker compose up -d
```

---

### 2. PostgreSQL ile Çalıştırma

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
      - BACKUP_INTERVAL_HOURS=48
      - MAX_BACKUPS=5
      - DATABASE_URL=postgres://postgres:password123@postgres:5432/edubadb
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
      POSTGRES_PASSWORD: password123
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata:
```

---

## Ortam Değişkenleri

| Değişken | Varsayılan | Açıklama |
| :--- | :--- | :--- |
| `PORT` | `3000` | Sunucu portu |
| `NODE_ENV` | `development` | Çalışma ortamı (`production` / `development`) |
| `SESSION_SECRET` | *(Otomatik)* | Çerez imzalama anahtarı (Boşsa `./data/cookie_secret.key` olarak otomatik üretilir ve korunur) |
| `ALLOW_REGISTRATION` | `true` | Yeni kullanıcı kayıt durumu (`true` / `false`) |
| `DATABASE_URL` | *(Boş)* | PostgreSQL bağlantı adresi (Boş ise SQLite kullanılır) |
| `DB_PATH` | `/app/data/sqlite.db` | SQLite dosya yolu |
| `BACKUP_INTERVAL_HOURS` | `48` | SQLite otomatik yedek alma sıklığı (Saat) |
| `MAX_BACKUPS` | `5` | Tutulacak maksimum SQLite yedek sayısı |
