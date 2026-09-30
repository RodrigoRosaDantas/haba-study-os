# HABA Study OS

Study OS local-first para a trilha BB + CAIXA TI do Habacuque, publicado como site estático e PWA.

## Modelo de dados

- **Notion:** fonte editorial. A sequência vem de `Estudo dia a dia — D01 a D75 | Habacuque`, ordenada por `Ordem`; revisões e descansos vêm da `Trilha semanal oficial — C01 a C05`.
- **GitHub Actions:** busca o Notion com a credencial somente leitura `HABA_STUDY_OS_LEITURA`, valida o conteúdo e atualiza `site/data/content.json` de forma atômica.
- **GitHub Pages:** publica a aplicação estática. Nenhuma resposta, erro, sessão ou progresso pessoal é publicado.
- **IndexedDB:** sessões, tentativas, respostas, progresso, erros, revisões, fila de sincronização e backups.
- **localStorage:** apenas preferências de interface.

## Desenvolvimento local

Requer Node.js 20 ou superior. Não há dependências de runtime.

```bash
npm test
npm run quality
python -m http.server 4173 --directory site
```

Abra `http://localhost:4173`.

## Sincronização editorial

No GitHub, configure o segredo `HABA_STUDY_OS_LEITURA` com o token da integração de leitura do Notion e compartilhe com ela as páginas/bancos necessários. O workflow **Sync Notion content** busca D01–D75, Q01–Q75, R01–R15 e os domingos. Um erro de API ou validação interrompe a execução sem substituir o último snapshot válido.

O botão de atualização do app abre esse workflow para execução manual. A sincronização agendada roda a cada seis horas.

## Escrita de erros no Notion

Tentativas, erros e observações funcionam localmente. O backend em `backend/worker.mjs` implementa leitura e upsert autenticados no banco existente **Caderno de erros — Habacuque**; ele não altera o schema do Notion. O navegador envia dados somente depois que um endpoint HTTPS e sua chave de acesso forem configurados nesta sessão.

O Worker ainda precisa ser implantado com uma integração Notion separada que tenha permissão de escrita no Caderno de erros. A integração `HABA_STUDY_OS_LEITURA` continua restrita ao GitHub Actions e nunca é usada para escrever. Instruções e variáveis necessárias estão em [`backend/README.md`](backend/README.md). Sem o Worker configurado, a fila permanece no IndexedDB e entra no backup.

Quando uma tentativa falha, a operação continua na fila e recebe nova tentativa automática com espera crescente, até seis horas entre tentativas. Se uma edição mais recente ocorrer enquanto a anterior está sendo enviada, a confirmação antiga não remove a versão nova da fila. O Error Lab mostra o estado e o horário da próxima tentativa; o botão permite tentar imediatamente.

O token de escrita do Notion fica em segredo do Worker. A chave de acesso do Worker fica apenas no `sessionStorage` da aba; não entra no localStorage, IndexedDB ou backup. O endpoint valida origem, autenticação, tamanho do payload, formato dos IDs, deduplicação e limite por IP.

## Publicação

Os workflows `quality.yml`, `sync-notion.yml`, `scheduled-sync.yml` e `deploy-pages.yml` cuidam da validação, sincronização e publicação por GitHub Pages. Se a primeira execução de sincronização falhar, o site mostrará o estado sem snapshot; o workflow não cria nem publica conteúdo vazio.
