import { scanSignals } from './scan.js';

console.log('🧪 Running Binance scanner test...\n');

scanSignals()
  .then((signals) => {
    console.log('\n✅ Test completed!');
    console.log(`📊 Generated ${signals.length} signals:`);
    signals.forEach((s, i) => {
      console.log(`  ${i + 1}. ${s.pair} | ${s.type} | ${s.price.toFixed(2)} | score=${s.score.toFixed(1)} | ${s.reason}`);
    });
  })
  .catch((error) => {
    console.error('❌ Test failed:', error);
    process.exit(1);
  });
