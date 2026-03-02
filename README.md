# CMDB Web — Docker Edition

Versão web do CMDB Inventário de Servidores, convertida de Electron para Docker.

## O que mudou

| Funcionalidade | Electron | Docker/Web |
|---|---|---|
| **Banco de dados** | `cmdb_data.json` local | Volume Docker `/data/cmdb_data.json` |
| **SSH (Nav Vault)** | Abre PuTTY externo | **Terminal xterm.js embutido** via WebSocket + node-pty |
| **SSH (Inventário)** | Baixa `.bat` (Windows) | Baixa `.sh` + copia senha pro clipboard |
| **RDP** | Abre `mstsc.exe` | Baixa arquivo `.rdp` para abrir no seu cliente RDP |
| **Export/Import** | Diálogo de arquivo nativo | Download/upload via browser |

## Executar

```bash
# Opção 1 — docker compose (recomendado)
docker compose up -d

# Opção 2 — manual
docker build -t cmdb-web .
docker run -d -p 3000:3000 -v cmdb-data:/data --name cmdb-web cmdb-web
```

Acesse: **http://localhost:3000**

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta HTTP do servidor |
| `DATA_FILE` | `/data/cmdb_data.json` | Caminho do arquivo de dados |

## SSH no Nav Vault

O terminal SSH roda nativamente dentro do container:
- Usa `ssh` (OpenSSH) via `node-pty` — terminal PTY real no browser
- Com senha cadastrada: usa `sshpass` para autenticação automática
- Suporta redimensionamento automático do terminal
- Funciona com qualquer host acessível pela rede do container

## Persistência

Os dados ficam no volume Docker `cmdb-data`. Para fazer backup:

```bash
# Exportar
docker cp cmdb-web:/data/cmdb_data.json ./backup.json

# Restaurar
docker cp ./backup.json cmdb-web:/data/cmdb_data.json
```

Ou use a função **Exportar/Importar** dentro da própria interface.
