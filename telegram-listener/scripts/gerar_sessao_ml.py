"""
Gera a sessao logada do Mercado Livre para a automacao de afiliados.
=====================================================================
Rode este script LOCALMENTE, na sua propria maquina — nunca no servidor.
Ele abre um navegador de verdade na sua tela; voce loga no Mercado Livre
manualmente (email, senha, 2FA, captcha — tudo direto na pagina oficial
deles). O script so salva os cookies resultantes da sessao; sua senha
nunca passa por este script nem pelo sistema.

O script fica observando sozinho a pagina e detecta quando o login foi
concluido (nao precisa voltar no terminal apertar Enter) — assim que
perceber que voce esta logado, salva o arquivo e fecha o navegador.

Uso:
    cd telegram-listener
    .venv\\Scripts\\python.exe scripts\\gerar_sessao_ml.py      (Windows)
    .venv/bin/python scripts/gerar_sessao_ml.py                  (Linux/Mac)

No final, faca upload do arquivo gerado (ml_storage_state.json) em:
    Configuracoes -> Links de Afiliado -> Mercado Livre -> Sessao
"""

import asyncio
from pathlib import Path

from playwright.async_api import async_playwright

OUTPUT_PATH = Path(__file__).resolve().parent.parent / "ml_storage_state.json"
LINK_BUILDER_URL = "https://www.mercadolivre.com.br/afiliados/linkbuilder"

POLL_INTERVAL_SECONDS = 3
TIMEOUT_SECONDS = 15 * 60  # 15 minutes to complete login (2FA, captcha etc take time)


def _looks_logged_in(current_url: str) -> bool:
    lowered = current_url.lower()
    return "login" not in lowered and "signin" not in lowered and "/gz/" not in lowered


async def main() -> None:
    print("Abrindo navegador...")
    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=False)
        context = await browser.new_context(locale="pt-BR")
        page = await context.new_page()
        await page.goto(LINK_BUILDER_URL)

        print()
        print("=" * 70)
        print("Faca login normalmente na janela que abriu (email/senha, 2FA etc).")
        print("Este script vai perceber sozinho quando voce terminar — so espere.")
        print("=" * 70)

        elapsed = 0
        logged_in = False
        while elapsed < TIMEOUT_SECONDS:
            await asyncio.sleep(POLL_INTERVAL_SECONDS)
            elapsed += POLL_INTERVAL_SECONDS
            try:
                if _looks_logged_in(page.url) and "linkbuilder" in page.url:
                    # Confirm it's really the logged-in tool page, not just a
                    # transient redirect mid-flow — check again after a short beat.
                    await asyncio.sleep(1)
                    if _looks_logged_in(page.url):
                        logged_in = True
                        break
            except Exception:
                # Page may be mid-navigation between polls — just retry next tick
                continue

        if not logged_in:
            print(f"\nTempo esgotado ({TIMEOUT_SECONDS // 60} min) sem detectar login. Rode o script de novo.")
            await browser.close()
            return

        print("\nLogin detectado! Salvando sessao...")
        await context.storage_state(path=str(OUTPUT_PATH))
        await browser.close()

    print(f"\nSessao salva em: {OUTPUT_PATH}")
    print("Agora faca upload desse arquivo em Configuracoes -> Links de Afiliado -> Mercado Livre.")


if __name__ == "__main__":
    asyncio.run(main())
