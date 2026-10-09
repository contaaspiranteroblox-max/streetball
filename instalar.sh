#!/bin/bash
# STREETBALL - instalador automatico (Ubuntu 22.04 / 24.04)
# Rode como root:  bash instalar.sh
set -e
echo "==> 1/5 Instalando Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | bash - > /dev/null 2>&1
apt-get install -y nodejs git > /dev/null 2>&1
echo "    Node $(node -v) instalado."

echo "==> 2/5 Baixando o jogo..."
rm -rf /root/streetball
git clone --depth 1 https://github.com/contaaspiranteroblox-max/streetball.git /root/streetball
cd /root/streetball

echo "==> 3/5 Instalando as pecas do servidor..."
npm install --no-audit --no-fund

echo "==> 4/5 Ligando o jogo com pm2 (fica no ar para sempre)..."
npm install -g pm2 > /dev/null 2>&1
pm2 delete streetball > /dev/null 2>&1 || true
PORT=80 pm2 start servidor.js --name streetball
pm2 save > /dev/null 2>&1
pm2 startup systemd -u root --hp /root > /dev/null 2>&1 || true
pm2 save > /dev/null 2>&1

echo "==> 5/5 Liberando a porta 80 no firewall (se houver)..."
(ufw allow 80 > /dev/null 2>&1 || true)

IP=$(curl -s ifconfig.me || hostname -I | cut -d" " -f1)
echo ""
echo "==========================================="
echo "   STREETBALL NO AR!"
echo "   Abra no celular:  http://$IP"
echo "   Ver se esta vivo: pm2 status"
echo "   Ver quem entra:   pm2 logs streetball"
echo "==========================================="
