# Respaldos de MongoDB — RenBotIA

Objetivo: nunca perder datos de clientes (negocios, bots, conversaciones, pagos).

## 0. Respaldo GRATIS por correo (recomendado mientras no haya backups de Atlas)

El servidor genera un respaldo de TODA la base, comprimido y **cifrado**
(AES-256-GCM), y te lo manda por correo como archivo `.rbk`.

**Variables en Render:**
- `BACKUP_EMAIL` — a dónde llega el respaldo.
- `BACKUP_PASSPHRASE` — frase para cifrarlo (mín. 12 caracteres). **Guárdala en
  tu gestor de contraseñas: sin ella el respaldo no se puede abrir.**
- `BACKUP_EVERY_DAYS` — opcional, cada cuántos días (por defecto 7).

Con las dos primeras definidas, el servidor manda el respaldo solo (revisa cada
6 h; el primero sale ~2 min después del arranque).

**Respaldo inmediato** (Shell de Render): `node scripts/backup-now.mjs`

**Ver / restaurar** (en tu computadora, desde `server/`):
```bash
BACKUP_PASSPHRASE="tu frase" node scripts/restore-backup.mjs renbotia-20261005-0300.rbk
BACKUP_PASSPHRASE="tu frase" node scripts/restore-backup.mjs archivo.rbk --uri "mongodb+srv://..." --confirm
```
El primero solo muestra el contenido. El segundo restaura (se niega si la base
destino tiene datos; `--drop` los reemplaza). Restaura primero en una base NUEVA.

Límite: si el respaldo supera ~28 MB ya no cabe como adjunto (el correo avisa).
Ese es el momento de activar los backups de Atlas.

---

## Método alterno: mongodump (requiere acceso directo a la base)

## 1. Instala las herramientas

Necesitas `mongodump` / `mongorestore` (MongoDB Database Tools):
https://www.mongodb.com/try/download/database-tools

Verifica: `mongodump --version`

## 2. Respaldo manual

```bash
cd server
bash scripts/backup-mongo.sh
```

Genera `server/backups/renbotia-<fecha>.archive.gz` y conserva los últimos 14.
Con otra base: `MONGODB_URI="mongodb://usuario:pass@host:27017/whatsapp_saas" bash scripts/backup-mongo.sh`

## 3. Respaldo AUTOMÁTICO (programado)

**Windows (Programador de tareas):** crea una tarea diaria que ejecute
`"C:\Program Files\Git\bin\bash.exe" -lc "cd /c/Users/Thinkpad/Proyectos/whatsapp-saas/server && bash scripts/backup-mongo.sh"`

**Linux/servidor (cron):** respaldo diario a las 3:00 am
```
0 3 * * * cd /ruta/whatsapp-saas/server && MONGODB_URI="..." bash scripts/backup-mongo.sh >> backups/backup.log 2>&1
```

> Guarda una copia **fuera del servidor** (otra máquina, S3, Google Drive, etc.).
> Un respaldo en el mismo disco que la base no te salva si el disco muere.

## 4. Restaurar

```bash
mongorestore --uri="$MONGODB_URI" --gzip --archive=backups/renbotia-<fecha>.archive.gz
```

Para sobrescribir colecciones existentes añade `--drop` (¡con cuidado!).

## 5. ¿Usas MongoDB Atlas?

Si migras a **Atlas** (recomendado para producción), trae respaldos automáticos
gestionados (snapshots continuos + point-in-time). En ese caso este script queda
como respaldo manual/extra, y activas los backups desde el panel de Atlas.
