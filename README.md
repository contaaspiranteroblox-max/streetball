# STREETBALL

Futebol de botao online (estilo HaxBall). As salas rodam na nuvem: o servidor calcula
a partida e cada jogador so manda direcao e chute - funciona liso ate com internet ruim.

## Colocar no ar (Ubuntu 22.04/24.04, como root)

```bash
bash <(curl -s https://raw.githubusercontent.com/contaaspiranteroblox-max/streetball/main/instalar.sh)
```

Depois abra `http://IP-DO-SERVIDOR` e jogue. Cada sala aguenta ate 12 pessoas;
o servidor aceita ate 10 salas ao mesmo tempo (mude com `MAX_SALAS=20 pm2 start servidor.js --name streetball`).

## Arquivos

- `index.html` - o jogo (v63)
- `servidor.js` - o servidor (salas na nuvem + o site)
- `sb-link.js` - a ponte WebSocket jogo <-> servidor
- `instalar.sh` - instalador automatico
