#!/bin/sh
# Roda automaticamente no start do container (via /docker-entrypoint.d/ do
# nginx:alpine), antes do nginx subir. Gera env-config.js a partir da env var
# WHATSAPP_URL_3D do container (definida no Portainer/docker-compose).
set -eu

envsubst '${WHATSAPP_URL_3D}' \
  < /usr/share/nginx/html/env-config.template.js \
  > /usr/share/nginx/html/env-config.js
