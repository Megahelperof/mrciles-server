const express = require('express');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;

// Initialize Firebase with Render-friendly config
if (!admin.apps.length) {
  try {
    const serviceAccount = JSON.parse(
      Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf-8')
    );
    
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
      databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
    });
    console.log('🔥 Firebase initialized successfully');
  } catch (error) {
    console.error('❌ FATAL: Firebase initialization failed:', error);
    process.exit(1);
  }
}

const db = admin.firestore();

// Serve static files
app.use(express.static('public'));

// API endpoint for products
app.get('/api/products', async (req, res) => {
  try {
    const productsRef = db.collection('products');
    const snapshot = await productsRef.orderBy('created_at', 'desc').get();
    
    const products = [];
    snapshot.forEach(doc => {
      products.push({ 
        id: doc.id, 
        ...doc.data(),
        // Convert Firestore Timestamp to ISO string for compatibility
        created_at: doc.data().created_at?.toDate?.()?.toISOString?.() 
      });
    });
    
    res.json(products);
  } catch (err) {
    console.error('Firestore error:', err);
    res.status(500).json({ error: 'Database error' });
  }
});

// HTML route
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});