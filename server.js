const express = require('express');
const admin = require('firebase-admin');
const app = express();
const port = process.env.PORT || 3000;
const cors = require('cors');
app.use(cors({
  origin: 'https://mrciles-server-1.onrender.com',
  methods: ['GET', 'POST']
}));

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
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static('public'));

// API endpoint for products
app.get('/api/products', async (req, res) => {
  try {
    const productsRef = db.collection('products');
    const snapshot = await productsRef.orderBy('created_at', 'desc').get();
    
    const products = [];
    snapshot.forEach(doc => {
      const data = doc.data();
      
      // Convert base64 images to data URLs
      if (data.image && data.image.data) {
        data.imageSrc = `data:${data.image.contentType};base64,${data.image.data}`;
      }
      
      products.push({ 
        id: doc.id, 
        ...data,
        created_at: data.created_at?.toDate?.()?.toISOString?.() 
      });
    });
    
    res.json(products);
  } catch (err) {
    // ... error handling ...
  }
});
app.post('/api/products/bulk', async (req, res) => {
  try {
    // Verify admin token
    const authToken = req.headers.authorization?.split(' ')[1];
    if (authToken !== process.env.ADMIN_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const { products } = req.body;
    
    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ error: 'Invalid products data' });
    }

    const batch = db.batch();
    const productsRef = db.collection('products');
    const addedIds = [];

    for (const product of products) {
      const docRef = productsRef.doc();
      
      // Create product data
      const productData = {
        name: product.name,
        price: product.price,
        link: product.link,
        mainCategory: product.mainCategory,
        subCategory: product.subCategory || null,
        image: {
          data: product.image.data,
          contentType: product.image.contentType,
          name: product.image.name
        },
        created_at: admin.firestore.FieldValue.serverTimestamp()
      };
      
      batch.set(docRef, productData);
      addedIds.push(docRef.id);
    }

    await batch.commit();
    
    res.json({
      success: true,
      message: `Added ${addedIds.length} products successfully`,
      productIds: addedIds
    });
    
  } catch (err) {
    console.error('Bulk upload error:', err);
    res.status(500).json({ error: 'Failed to bulk upload products' });
  }
});
// HTML route
app.get('*', (req, res) => {
  res.sendFile('index.html', { root: 'public' });
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});