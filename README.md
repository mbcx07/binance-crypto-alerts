# Binance Crypto Alerts

Bot de oportunidades cripto en Binance Futures (USDT-M PERPETUAL) con alertas en Telegram.

## 🚀 Características

- **Scanner de Futuros USDT-M**: Monitorea todos los pares perpétuales
- **Frecuencia**: Cada 15 minutos (GitHub Actions cron)
- **Estrategia**: Ranking combinado (Breakout + Volumen + Volatilidad)
- **Anti-spam**: Top 5 oportunidades + cooldown por símbolo (60 min)
- **Alertas Telegram**: Mensajes en tiempo real con formato estándar

## 📊 Estrategia de Detección

### Filtros de Calidad
- Volumen 24h mínimo: 5M USDT
- Top 200 por volumen
- Pre-filtro de liquidez

### Indicadores Técnicos
- **Breakout (20 velas)**: Ruptura de máximos/mínimos
- **Volumen Spike**: Volumen actual vs promedio 20 velas
- **ATR (14)**: Volatilidad normalizada

### Scoring
```
score = breakout_strength + volume_spike + atr_factor
```

Máximo score: 10. Solo se envían señales con score >= 4.

### Formato de Alerta Telegram
```
[15m][USDT-M] BTCUSDT | BUY | 67250.00 | score=8.4 | breakout(20)+volSpike(2.1)+ATR | 2026-03-10T21:00:00.000Z
```

## 🛠️ Setup

### Requisitos
- Node.js 20+
- Git
- Cuenta GitHub
- Telegram Bot (token + chat_id)

### Instalación

```bash
git clone https://github.com/mbcx07/binance-crypto-alerts.git
cd binance-crypto-alerts

# Setup frontend
cd web
npm install
npm run dev

# Setup worker
cd ../worker
npm install
npm run test  # Test local del scanner
```

### Configuración de GitHub Secrets

Ir a `GitHub → Settings → Secrets and variables → Actions` y agregar:

- `TELEGRAM_BOT_TOKEN`: Token del bot de Telegram
- `TELEGRAM_CHAT_ID`: ID del chat o grupo donde llegarán las alertas

### Deploy en GitHub Pages

El frontend se despliega automáticamente a GitHub Pages.

URL: `https://mbcx07.github.io/binance-crypto-alerts/`

## 📁 Estructura del Proyecto

```
binance-crypto-alerts/
├── web/                    # Frontend (React + Vite)
│   ├── src/
│   ├── public/
│   └── vite.config.ts
├── worker/                 # Worker Node.js
│   ├── scan.js            # Scanner principal
│   ├── test.js            # Tests
│   └── package.json
├── data/                   # Archivos de datos (persistencia)
│   ├── signals.json       # Últimas señales
│   └── last-signals.json  # Cooldown tracking
├── .github/workflows/      # GitHub Actions
│   └── binance-scan.yml   # Workflow con cron 15m
└── README.md
```

## 🧪 Testing

```bash
cd worker
npm run test
```

Esto ejecuta el scanner localmente sin enviar alertas a Telegram.

## 📝 Configuración del Scanner

Editar `worker/scan.js` para ajustar:

```javascript
const CONFIG = {
  scanner: {
    topN: 5,                    // Número de alertas
    timeframe: '15m',           // Timeframe
    minVolume: 5000000,        // Volumen mínimo 24h (USDT)
    cooldownMinutes: 60,        // Cooldown por símbolo
    breakoutPeriod: 20,        # Velas para breakout
    atrPeriod: 14,             # Período ATR
    volumeSpikeThreshold: 1.5,  # Umbral de volumen spike
  },
};
```

## 🔒 Seguridad

- Todos los secrets están en GitHub Actions
- Validación de datos con Zod
- Rate limiting de APIs
- No se ejecutan trades, solo alertas

## 📄 Licencia

MIT

## 👨‍💻 Autor

Proyecto desarrollado por Pia y su equipo de sub-agentes bajo supervisión de Max.
