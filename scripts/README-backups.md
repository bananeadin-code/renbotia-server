# Respaldos de MongoDB — RenBotIA

Objetivo: nunca perder datos de clientes (negocios, bots, conversaciones, pagos).
Haz esto **antes** de producción, no después de un susto.

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
