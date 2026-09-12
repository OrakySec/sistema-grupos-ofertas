// Fallback usado em dev (npm run dev/build) e caso o entrypoint do container
// não rode por algum motivo. Em produção este arquivo é sobrescrito no start
// do container a partir da env var WHATSAPP_URL_3D (ver docker-entrypoint-env.sh).
window.__ENV__ = {
  WHATSAPP_URL_3D: "https://chat.whatsapp.com/C0cPDxI9ViB25Y6NUVUmyL?mode=gi_t",
};
