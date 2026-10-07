/**
 * scripts/upload-logo-firebase.js — Sobe a logo Performe+ para o Firebase Firestore
 * Uso: node scripts/upload-logo-firebase.js [caminho-da-logo.png]
 * Se nenhum caminho for informado, usa assets/logo-performe.png
 */

const path = require('path');
const fs = require('fs');

// Carrega config e inicializa Firebase
const config = require('../config');

async function main() {
  const logoPath = process.argv[2] || path.join(__dirname, '..', 'assets', 'logo-performe.png');

  if (!fs.existsSync(logoPath)) {
    console.error('Arquivo nao encontrado: ' + logoPath);
    process.exit(1);
  }

  const logoBuf = fs.readFileSync(logoPath);
  const logoBase64 = logoBuf.toString('base64');

  console.log('Logo: ' + logoPath + ' (' + logoBuf.length + ' bytes)');

  // Inicializa Firebase
  const admin = require('firebase-admin');
  if (admin.apps.length === 0) {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: config.firebase.project_id,
        privateKey: config.firebase.private_key,
        clientEmail: config.firebase.client_email,
      }),
    });
  }

  const db = admin.firestore();
  await db.collection(config.firebase.collection).doc('logo').set({
    logoBase64: logoBase64,
    tamanho: logoBuf.length,
    uploadEm: new Date().toISOString(),
  });

  console.log('Logo salva no Firebase Firestore: ' + config.firebase.collection + '/logo');
  console.log('Tamanho base64: ' + logoBase64.length + ' chars');
}

main().catch(e => {
  console.error('Erro:', e.message);
  process.exit(1);
});
