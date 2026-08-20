#!/usr/bin/env bash
#
# Respaldo automático de la base de datos de RenBotIA (MongoDB) con mongodump.
# Crea un archivo comprimido con marca de tiempo y conserva los últimos 14.
#
# Requiere las MongoDB Database Tools (mongodump/mongorestore):
#   https://www.mongodb.com/try/download/database-tools
#
# Uso manual:   bash scripts/backup-mongo.sh
# Variables:    MONGODB_URI (por defecto la local), BACKUP_DIR (por defecto ./backups)
#
set -euo pipefail

MONGODB_URI="${MONGODB_URI:-mongodb://127.0.0.1:27017/whatsapp_saas}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION="${RETENTION:-14}" # cuántos respaldos conservar

mkdir -p "$BACKUP_DIR"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$BACKUP_DIR/renbotia-$STAMP.archive.gz"

echo "[backup] Respaldeando a $OUT ..."
mongodump --uri="$MONGODB_URI" --gzip --archive="$OUT"

# Retención: borra los respaldos más antiguos que superen el límite.
ls -1t "$BACKUP_DIR"/renbotia-*.archive.gz 2>/dev/null | tail -n "+$((RETENTION + 1))" | xargs -r rm -f

echo "[backup] Listo. Respaldos actuales:"
ls -1t "$BACKUP_DIR"/renbotia-*.archive.gz 2>/dev/null | head -n "$RETENTION"
