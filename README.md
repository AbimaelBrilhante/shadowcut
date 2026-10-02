# ShadowCut

MVP pessoal para transformar vídeos públicos do YouTube em sessões curtas de shadowing.

## Objetivo da V0.1

- Colar uma URL pública do YouTube.
- A IA escolhe automaticamente até 5 trechos de 60–120 segundos.
- O player usa o vídeo original do YouTube.
- Legendas EN / PT / EN+PT.
- Velocidade ajustável.
- Repetição frase por frase.

## Arquitetura

- Next.js
- YouTube IFrame API
- Gemini API (Free Tier)
- Deploy sugerido: Vercel Hobby

Nenhum vídeo é baixado pelo ShadowCut.

## Variáveis de ambiente

```bash
GEMINI_API_KEY=...
GEMINI_MODEL=gemini-3.8-flash
```

## Rodar localmente

```bash
npm install
npm run dev
```

Abra http://localhost:3000.

> Uso pessoal / MVP. A análise direta de URLs do YouTube no Gemini está em preview e os limites podem mudar.
