# NaNota

App de músicas, cifras e repertórios, com login individual, e página de notas e acordes ao vivo pelo microfone.

- `public/index.html`: o app (biblioteca, editor, transposição, repertórios, modo palco, importação)
- `public/ao-vivo.html`: notas e acordes em tempo real pelo microfone
- `public/usuarios.html`: módulo de usuários (cadastro, convites, perfis e planos)
- `public/financeiro.html`: módulo financeiro (resumo, cobranças, assinaturas, planos, PIX)
- `public/admin.js`, `public/admin.css`: base comum dos módulos
- `src/worker.js`: servidor (login, convites, troca de senha, usuários, músicas)
- `src/groups.js`: repertórios em grupo, permissões e histórico
- `src/finance.js`: assinaturas, cobranças e PIX
- `src/lib.js`: funções compartilhadas do servidor
- `migrations/`: alterações do banco D1 (já aplicadas)
- `wrangler.jsonc`: configuração da Cloudflare (Worker `nanota` + banco D1 `nanota-db`)
- `index.html` (raiz): versão estática da página ao vivo, para o GitHub Pages

## Publicar na Cloudflare
Workers & Pages → Create → Import a repository → escolha `nanota`. A cada envio para `main`, a Cloudflare publica de novo.
