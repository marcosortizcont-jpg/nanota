# NaNota

App de músicas, cifras e repertórios, com login individual, e página de notas e acordes ao vivo pelo microfone.

- `public/index.html`: o app (biblioteca, editor, transposição, repertórios, modo palco, importação)
- `public/ao-vivo.html`: notas e acordes em tempo real pelo microfone
- `src/worker.js`: servidor (login, convites, troca de senha, usuários, músicas e repertórios)
- `wrangler.jsonc`: configuração da Cloudflare (Worker `nanota` + banco D1 `nanota-db`)
- `index.html` (raiz): versão estática da página ao vivo, para o GitHub Pages

## Publicar na Cloudflare
Workers & Pages → Create → Import a repository → escolha `nanota`. A cada envio para `main`, a Cloudflare publica de novo.
