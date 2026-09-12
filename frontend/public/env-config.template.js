// Preenchido em runtime pelo entrypoint do container (envsubst), a partir das
// variáveis de ambiente do serviço "frontend" (ex.: definidas no Portainer).
// Ver frontend/docker-entrypoint-env.sh.
window.__ENV__ = {
  WHATSAPP_URL_3D: "${WHATSAPP_URL_3D}",
};
