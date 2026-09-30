# HABA Study OS

Study OS local-first para a trilha BB + CAIXA TI do Habacuque, publicado como site estático e PWA.

## Modelo de dados

- **Notion:** fonte editorial. A sequência vem de `Estudo dia a dia — D01 a D75 | Habacuque`, ordenada por `Ordem`; revisões e descansos vêm da `Trilha semanal oficial — C01 a C05`.
- **GitHub Actions:** busca o Notion com a credencial somente leitura `HABA_STUDY_OS_LEITURA`, valida o conteúdo e atualiza `site/data/content.json` de forma atômica.
- **GitHub Pages:** publica a aplicação estática. Nenhuma resposta, erro, sessão ou progresso pessoal é publicado.
- **IndexedDB:** sessões, tentativas, respostas, progresso, erros, revisões e backups.
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

## Dados pessoais do Error Lab

Erros, revisões, motivos, macetes e observações ficam somente no IndexedDB do dispositivo atual. Eles não são enviados ao Notion nem publicados no GitHub Pages. Para levar os registros a outro dispositivo, exporte e restaure o backup JSON em **Configurações**. A sincronização do Notion continua restrita à leitura de conteúdo editorial pelo GitHub Actions.

## Publicação

Os workflows `quality.yml`, `sync-notion.yml`, `scheduled-sync.yml` e `deploy-pages.yml` cuidam da validação, sincronização e publicação por GitHub Pages. Se a primeira execução de sincronização falhar, o site mostrará o estado sem snapshot; o workflow não cria nem publica conteúdo vazio.
