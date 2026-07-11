// routes/marketplaceRoutes.js
const express = require('express');
const router = express.Router();
const multer = require('multer');
const MarketplaceProduct = require('../models/MarketplaceProduct');
const MarketplaceChat = require('../models/MarketplaceChat');
const MarketplaceMessage = require('../models/MarketplaceMessage');
const Order = require('../models/Order'); // ✅ NAYA
const SellerKYC = require('../models/SellerKYC');
const cacheModule = require('../middleware/cacheMiddleware');

// Cloudinary setup
let cloudinary;
try {
    cloudinary = require('cloudinary').v2;
    cloudinary.config({
        cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
        api_key: process.env.CLOUDINARY_API_KEY,
        api_secret: process.env.CLOUDINARY_API_SECRET,
        timeout: 60000
    });
    console.log('✅ Cloudinary configured for marketplace');
} catch (err) {
    console.log('⚠️ Cloudinary not available');
}

const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 5 * 1024 * 1024, files: 5 },  // 🛡️ 5MB, 5 files
    fileFilter: (req, file, cb) => {
        // 🛡️ Whitelist specific image types
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (allowedMimes.includes(file.mimetype)) {
            cb(null, true);
        } else {
            cb(new Error('Only JPG, PNG, WebP images allowed!'), false);
        }
    }
});

// Auth middleware
function isLoggedIn(req, res, next) {
    if (req.session && req.session.userId) return next();
    return res.status(401).json({ error: 'Login required' });
}

// Cloudinary upload helper
async function uploadToCloudinary(file) {
    return new Promise((resolve, reject) => {
        // 🛡️ SECURITY: Validate file exists
        if (!file || !file.buffer) {
            return reject(new Error('Invalid file'));
        }
        
        // 🛡️ SECURITY: Whitelist MIME types
        const allowedMimes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
        if (!allowedMimes.includes(file.mimetype)) {
            return reject(new Error('Invalid file type'));
        }
        
        const b64 = file.buffer.toString('base64');
        const dataURI = `data:${file.mimetype};base64,${b64}`;
        cloudinary.uploader.upload(dataURI, {
            folder: 'marketplace',
            resource_type: 'auto',
            timeout: 30000,
            // 🛡️ SECURITY: Strip EXIF data
            transformation: [{ flags: 'strip_profile' }]
        }, (error, result) => {
            if (error) reject(error);
            else resolve(result);
        });
    });
}

// ==========================================
// ✅ ROUTES
// ==========================================

// 1. Main page
router.get('/', (req, res) => {
    res.render('marketplace', {
        title: 'Marketplace - Billing SaaS',
        session: req.session || null
    });
});

// ==================== PRODUCT APIs ====================

// ✅ GET all products - Search, Filter, Sort + KYC Data
router.get('/api/products', cacheModule.cacheMiddleware(60), async (req, res) => {
    try {
        // 🛡️ SECURITY: Sanitize inputs
        const search = String(req.query.search || '').trim().substring(0, 100);
        
        // 🛡️ SECURITY: Whitelist category
        const allowedCategories = ['All', 'Electronics', 'Fashion', 'Home & Garden', 'Sports', 'Books', 'Toys', 'Vehicles', 'Property', 'Services', 'Others'];
        const category = allowedCategories.includes(req.query.category) ? req.query.category : 'All';
        
        // 🛡️ SECURITY: Whitelist sort
        const allowedSorts = ['newest', 'oldest', 'price_asc', 'price_desc', 'views', 'rating', 'reviews', 'orders', 'verified'];
        const sort = allowedSorts.includes(req.query.sort) ? req.query.sort : 'newest';
        
        // 🛡️ SECURITY: Whitelist tag
        const allowedTags = ['All', 'New', 'Sale', 'Hot Deal', 'Limited', 'Premium', 'Trending', 'Best Value'];
        const tag = allowedTags.includes(req.query.tag) ? req.query.tag : 'All';
        
        const pincode = String(req.query.pincode || '').trim().substring(0, 6);
        
        let query = {};

        query.isActive = true;
        
                // 🔍 Search: Title, Description, Product ID, Seller, Location, Category
        if (search) {
            // 🛡️ SECURITY: Escape regex special chars
            const safeSearch = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const rx = { $regex: safeSearch, $options: 'i' };
            query.$or = [
                { title: rx, isActive: true },
                { description: rx, isActive: true },
                { productId: rx, isActive: true },
                { sellerName: rx, isActive: true },
                { location: rx, isActive: true },
                { category: rx, isActive: true }
            ];
        }
        
        // 🏷️ Tag filter
        if (tag && tag !== 'All') {
            query.tags = tag;
        }

        if (pincode) {
            query.pincode = pincode;
        }

        // 🏷️ Category filter
        if (category && category !== 'All') {
            if (query.$or) {
                query = { $and: [{ $or: query.$or }, { category }, { isActive: true }] };
            } else {
                query.category = category;
            }
        }
        
        // 📊 Sort options
        let sortOption = { createdAt: -1 };
        
        if (sort === 'oldest') sortOption = { createdAt: 1 };
        else if (sort === 'price_asc') sortOption = { price: 1 };
        else if (sort === 'price_desc') sortOption = { price: -1 };
        else if (sort === 'views') sortOption = { views: -1 };
        else if (sort === 'rating') sortOption = { avgRating: -1, reviewsCount: -1 };
        else if (sort === 'reviews') sortOption = { reviewsCount: -1 };
        else if (sort === 'orders') sortOption = { ordersCount: -1 };
        else if (sort === 'verified') sortOption = { createdAt: -1 };
        
        // ✅ ALWAYS use aggregation to include real reviews data
        // 🛡️ SECURITY: Query timeout
        const products = await MarketplaceProduct.aggregate([
            { $match: query },
            {
                $lookup: {
                    from: 'reviews',
                    localField: 'productId',
                    foreignField: 'productId',
                    as: 'reviewsData'
                }
            },
            {
                $addFields: {
                    reviewsCount: { $size: '$reviewsData' },
                    avgRating: {
                        $cond: [
                            { $gt: [{ $size: '$reviewsData' }, 0] },
                            { $round: [{ $avg: '$reviewsData.rating' }, 1] },
                            0
                        ]
                    }
                }
            },
            { $sort: sortOption },
            { $limit: 50 },
            { $project: { reviewsData: 0 } }
        ]).option({ maxTimeMS: 5000 });
        
        // 👤 Get unique seller IDs
        const sellerIds = [...new Set(products.map(p => p.sellerId?.toString()).filter(Boolean))];
        
        // ✅ Fetch KYC for all sellers
        // 🛡️ SECURITY: Query timeout
        const kycData = await SellerKYC.find({ userId: { $in: sellerIds } })
            .lean()
            .maxTimeMS(3000);
        
        // 🗺️ Map KYC by userId
        const kycMap = {};
        kycData.forEach(k => {
            kycMap[k.userId.toString()] = {
                isVerified: k.status === 'verified',
                trustScore: Number(k.trustScore) || 0,
                status: k.status || 'not_submitted',
                signature: { url: String(k.signature?.url || '').substring(0, 500) }
            };
        });
        
        // 🔗 Attach KYC to each product
        const productsWithKYC = products.map(p => ({
            ...p,
            sellerKYC: kycMap[p.sellerId?.toString()] || { 
                isVerified: false, trustScore: 0, 
                status: 'not_submitted', signature: { url: '' } 
            }
        }));
        
        // 🔰 Verified sort
        if (sort === 'verified') {
            productsWithKYC.sort((a, b) => {
                if (a.sellerKYC?.isVerified && !b.sellerKYC?.isVerified) return -1;
                if (!a.sellerKYC?.isVerified && b.sellerKYC?.isVerified) return 1;
                return new Date(b.createdAt) - new Date(a.createdAt);
            });
        }
        
        res.json({ success: true, products: productsWithKYC });
        
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Products Error:', {
            msg: err.message,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch products' });
    }
});

// GET my products
router.get('/api/my-products', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Query timeout + limit
        const products = await MarketplaceProduct.find({ 
            sellerId: req.session.userId 
        }).sort({ createdAt: -1 }).lean().maxTimeMS(5000).limit(100);
        
        res.json({ success: true, products });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('My Products Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch products' });
    }
});

// POST create product
router.post('/api/product/create', isLoggedIn, (req, res, next) => {
    upload.array('media', 5)(req, res, (err) => {
        if (err) {
            if (err.message.includes('Only images allowed')) {
                return res.status(400).json({ success: false, errorCode: 'INVALID_FILE', error: 'Only JPG, PNG, WebP images allowed!' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, errorCode: 'FILE_TOO_LARGE', error: 'File too large. Max 5MB each.' });
            }
            return res.status(400).json({ success: false, errorCode: 'UPLOAD_ERROR', error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        console.log('📦 Create product request');
        
        // 🛡️ SECURITY: Sanitize inputs
        const title = String(req.body.title || '').trim().substring(0, 200);
        const description = String(req.body.description || '').trim().substring(0, 5000);
        const price = parseFloat(req.body.price);
        const category = String(req.body.category || '').substring(0, 50);
        const location = String(req.body.location || '').trim().substring(0, 200);
        const contactNumber = String(req.body.contactNumber || '').trim().substring(0, 10);
        const pincode = String(req.body.pincode || '').trim().substring(0, 6);
        const quantity = Math.max(0, parseInt(req.body.quantity) || 1);
        
        // 🛡️ SECURITY: Whitelist category
        const allowedCategories = ['Electronics', 'Fashion', 'Home & Garden', 'Sports', 'Books', 'Toys', 'Vehicles', 'Property', 'Services', 'Others'];
        const safeCategory = allowedCategories.includes(category) ? category : 'Others';
        
        if (!title || !description || !price || !category) {
            return res.status(400).json({ success: false, errorCode: 'MISSING_FIELDS', error: 'All fields required' });
        }
        
        // 🛡️ SECURITY: Price validation
        if (isNaN(price) || price < 0 || price > 999999) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_PRICE', error: 'Price must be 0-999999' });
        }
        
        if (!req.files || req.files.length === 0) {
            return res.status(400).json({ success: false, errorCode: 'NO_IMAGES', error: 'Please upload at least one image' });
        }
        
        let tags = req.body.tags || [];
        if (!Array.isArray(tags)) {
            tags = [tags];
        }
        // 🛡️ SECURITY: Whitelist tags
        const allowedTags = ['New', 'Sale', 'Hot Deal', 'Limited', 'Premium', 'Trending', 'Best Value'];
        tags = tags.filter(t => allowedTags.includes(String(t).trim())).map(t => String(t).trim());

        const autoRestock = req.body.autoRestock === 'true' || req.body.autoRestock === true;
        
        // 🛡️ SECURITY: Query timeout
        const count = await MarketplaceProduct.countDocuments().maxTimeMS(3000);
        const productId = `MP-${10000 + count + 1}`;
        
        const images = [];
        
        if (cloudinary) {
            for (const file of req.files) {
                try {
                    const result = await uploadToCloudinary(file);
                    images.push({ 
                        url: String(result.secure_url).substring(0, 500), 
                        publicId: String(result.public_id).substring(0, 100) 
                    });
                    console.log('✅ Uploaded:', result.secure_url);
                } catch (e) {
                    console.error('Upload error:', e.message);
                }
            }
        }
        
        if (images.length === 0) {
            return res.status(400).json({ success: false, errorCode: 'UPLOAD_FAILED', error: 'Image upload failed. Please try again.' });
        }
        
        const product = new MarketplaceProduct({
            productId,
            sellerId: req.session.userId,
            sellerName: String(req.session.userName || 'Seller').substring(0, 100),
            title,
            description,
            price,
            category: safeCategory,
            location,
            contactNumber,
            autoRestock,
            returnPolicy: {
    enabled: req.body.returnEnabled === 'true' || req.body.returnEnabled === true,
    days: Math.min(Math.max(parseInt(req.body.returnDays) || 7, 1), 30)
},
            images,
            videos: [],
            tags,
            pincode,
            quantity
        });
        
        await product.save();
        console.log('✅ Product created:', productId);
        res.json({ success: true, message: 'Product listed!', product });
        
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Create Product Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to create product' });
    }
});

// ✅ GET single product - WITH FALLBACK SEARCH + KYC DATA + SIGNATURE
router.get('/api/product/:productId', async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate productId
        let searchId = String(req.params.productId || '').substring(0, 50);
        if (!searchId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid product ID' });
        }
        
        console.log('🔍 Searching product:', searchId);
        
        // 🛡️ SECURITY: Query timeout
        let product = await MarketplaceProduct.findOne({ productId: searchId }).lean().maxTimeMS(3000);
        
        if (!product && !searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: `#${searchId}` }).lean().maxTimeMS(3000);
        }
        if (!product && searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: searchId.substring(1) }).lean().maxTimeMS(3000);
        }
        
        if (!product) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Product not found' });
        }
        
        await MarketplaceProduct.updateOne(
            { productId: product.productId },
            { $inc: { views: 1 } }
        ).maxTimeMS(3000);
        product.views = (Number(product.views) || 0) + 1;
        
        // ✅ Attach seller KYC + Phone from product's contactNumber
        if (product.sellerId) {
            try {
                // 🛡️ SECURITY: Query timeout
                const kyc = await SellerKYC.findOne({ userId: product.sellerId }).lean().maxTimeMS(3000);
                
                // 🛡️ SECURITY: Safe phone handling
                const phone = (kyc?.status === 'verified' && product.contactNumber) 
                    ? String(product.contactNumber).substring(0, 10)
                    : '';
                
                product.sellerKYC = kyc ? {
                    isVerified: kyc.status === 'verified',
                    trustScore: Number(kyc.trustScore) || 0,
                    status: kyc.status || 'not_submitted',
                    signature: { url: String(kyc.signature?.url || '').substring(0, 500) },
                    phone: phone
                } : { 
                    isVerified: false, trustScore: 0, status: 'not_submitted',
                    signature: { url: '' }, phone: ''
                };
            } catch (kycErr) {
                product.sellerKYC = { 
                    isVerified: false, trustScore: 0, status: 'not_submitted',
                    signature: { url: '' }, phone: ''
                };
            }
        } else {
            product.sellerKYC = { 
                isVerified: false, trustScore: 0, status: 'not_submitted',
                signature: { url: '' }, phone: ''
            };
        }
        
        console.log('✅ Found:', product.title);
        
        res.json({ success: true, product });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Product Error:', {
            msg: err.message,
            productId: req.params.productId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch product' });
    }
});


// PUT update product
router.put('/api/product/:productId', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate productId
        let searchId = String(req.params.productId || '').substring(0, 50);
        if (!searchId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid product ID' });
        }
        
        // 🛡️ SECURITY: Query timeout + ownership check
        let product = await MarketplaceProduct.findOne({ productId: searchId, sellerId: req.session.userId }).maxTimeMS(3000);
        if (!product && !searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: `#${searchId}`, sellerId: req.session.userId }).maxTimeMS(3000);
        }
        if (!product && searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: searchId.substring(1), sellerId: req.session.userId }).maxTimeMS(3000);
        }
        
        if (!product) {
            return res.status(403).json({ success: false, errorCode: 'NOT_AUTHORIZED', error: 'Not authorized' });
        }
        
        // 🛡️ SECURITY: Whitelist allowed fields + sanitize
        const allowedFields = ['title', 'description', 'price', 'category', 'location', 'status', 'tags', 'contactNumber', 'pincode', 'autoRestock', 'quantity'];
        
        // 🛡️ SECURITY: Whitelist category
        const allowedCategories = ['Electronics', 'Fashion', 'Home & Garden', 'Sports', 'Books', 'Toys', 'Vehicles', 'Property', 'Services', 'Others'];
        
        // 🛡️ SECURITY: Whitelist status
        const allowedStatuses = ['Available', 'Reserved', 'Sold'];
        
        allowedFields.forEach(key => {
            if (req.body[key] !== undefined) {
                if (key === 'title') product[key] = String(req.body[key]).trim().substring(0, 200);
                else if (key === 'description') product[key] = String(req.body[key]).trim().substring(0, 5000);
                else if (key === 'price') product[key] = Math.min(Math.max(parseFloat(req.body[key]) || 0, 0), 999999);
                else if (key === 'category' && allowedCategories.includes(req.body[key])) product[key] = req.body[key];
                else if (key === 'status' && allowedStatuses.includes(req.body[key])) product[key] = req.body[key];
                else if (key === 'location') product[key] = String(req.body[key]).trim().substring(0, 200);
                else if (key === 'contactNumber') product[key] = String(req.body[key]).trim().substring(0, 10);
                else if (key === 'pincode') product[key] = String(req.body[key]).trim().substring(0, 6);
                else if (key === 'tags') product[key] = req.body[key];
                else if (key === 'autoRestock') product[key] = req.body[key] === true || req.body[key] === 'true';
                else if (key === 'quantity') product[key] = Math.max(0, parseInt(req.body[key]) || 1);
            }
        });
        
        await product.save();
        res.json({ success: true, message: 'Product updated', product });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Update Product Error:', {
            msg: err.message,
            productId: req.params.productId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to update product' });
    }
});

// DELETE product
router.delete('/api/product/:productId', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate productId
        let searchId = String(req.params.productId || '').substring(0, 50);
        if (!searchId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid product ID' });
        }
        
        // 🛡️ SECURITY: Query timeout + ownership check
        let product = await MarketplaceProduct.findOneAndDelete({ 
            productId: searchId, 
            sellerId: req.session.userId 
        }).maxTimeMS(3000);
        
        if (!product && !searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOneAndDelete({ 
                productId: `#${searchId}`, 
                sellerId: req.session.userId 
            }).maxTimeMS(3000);
        }
        if (!product && searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOneAndDelete({ 
                productId: searchId.substring(1), 
                sellerId: req.session.userId 
            }).maxTimeMS(3000);
        }
        
        if (!product) {
            return res.status(403).json({ success: false, errorCode: 'NOT_AUTHORIZED', error: 'Not authorized' });
        }
        
        // ✅ Delete all reviews for this product
        const Review = require('../models/Review');
        const deletedReviews = await Review.deleteMany({ productId: product.productId }).maxTimeMS(3000);
        console.log(`🗑️ Deleted ${deletedReviews.deletedCount} reviews for ${product.productId}`);
        
        // Delete Cloudinary files
        if (cloudinary) {
            for (const img of product.images) {
                if (img.publicId) cloudinary.uploader.destroy(img.publicId).catch(() => {});
            }
            for (const vid of product.videos) {
                if (vid.publicId) cloudinary.uploader.destroy(vid.publicId, { resource_type: 'video' }).catch(() => {});
            }
        }
        
        res.json({ success: true, message: 'Product deleted' });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Delete Product Error:', {
            msg: err.message,
            productId: req.params.productId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to delete product' });
    }
});

// ==================== CHAT APIs ====================

// POST create/get chat
router.post('/api/chat/create', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Sanitize productId
        const productId = String(req.body.productId || '').substring(0, 50);
        if (!productId) {
            return res.status(400).json({ success: false, errorCode: 'MISSING_ID', error: 'Product ID required' });
        }
        
        console.log('💬 Chat request for product:', productId);
        
        // 🛡️ SECURITY: Query timeout
        let product = await MarketplaceProduct.findOne({ productId }).maxTimeMS(3000);
        if (!product && !productId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: `#${productId}` }).maxTimeMS(3000);
        }
        if (!product && productId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: productId.substring(1) }).maxTimeMS(3000);
        }
        
        if (!product) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Product not found' });
        }
        
        if (product.sellerId.toString() === req.session.userId.toString()) {
            return res.status(400).json({ success: false, errorCode: 'SELF_CHAT', error: 'Cannot chat with yourself' });
        }
        
        // 🛡️ SECURITY: Query timeout
        let chat = await MarketplaceChat.findOne({
            productId: product.productId,
            buyerId: req.session.userId,
            sellerId: product.sellerId
        }).maxTimeMS(3000);
        
        if (!chat) {
            const roomId = `MP-CHAT-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
            
            chat = new MarketplaceChat({
                roomId,
                productId: product.productId,
                product: {
                    title: String(product.title || '').substring(0, 200),
                    price: Number(product.price) || 0,
                    image: String(product.images?.[0]?.url || '').substring(0, 500),
                    sellerName: String(product.sellerName || '').substring(0, 100),
                    sellerId: product.sellerId
                },
                buyerId: req.session.userId,
                buyerName: String(req.session.userName || 'Buyer').substring(0, 100),
                sellerId: product.sellerId,
                sellerName: String(product.sellerName || 'Seller').substring(0, 100)
            });
            
            await chat.save();
            console.log('✅ Chat created:', roomId);
        } else {
            console.log('📨 Existing chat found:', chat.roomId);
        }
        
        res.json({ success: true, chat });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Chat Create Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to create chat' });
    }
});

// GET user's chats
router.get('/api/chats', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Query timeout + limit
        const chats = await MarketplaceChat.find({
            $or: [
                { buyerId: req.session.userId },
                { sellerId: req.session.userId }
            ],
            isActive: true
        }).sort({ updatedAt: -1 }).lean().maxTimeMS(5000).limit(50);
        
        res.json({ success: true, chats });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Chats Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch chats' });
    }
});

// GET chat messages
router.get('/api/chat/:roomId/messages', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate roomId
        const roomId = String(req.params.roomId || '').substring(0, 100);
        if (!roomId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid room ID' });
        }
        
        // 🛡️ SECURITY: Query timeout
        const chat = await MarketplaceChat.findOne({ roomId }).maxTimeMS(3000);
        if (!chat) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Chat not found' });
        }
        
        // 🛡️ SECURITY: Ownership check
        const isParticipant = 
            chat.buyerId.toString() === req.session.userId.toString() || 
            chat.sellerId.toString() === req.session.userId.toString();
        
        if (!isParticipant) {
            return res.status(403).json({ success: false, errorCode: 'NOT_AUTHORIZED', error: 'Not authorized' });
        }
        
        // 🛡️ SECURITY: Query timeout + limit
        const messages = await MarketplaceMessage.find({
            roomId,
            isDeleted: false
        }).sort({ timestamp: 1 }).lean().maxTimeMS(5000).limit(200);
        
        res.json({ success: true, messages });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Messages Error:', {
            msg: err.message,
            roomId: req.params.roomId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch messages' });
    }
});

// POST payment proof
router.post('/api/chat/:roomId/payment-proof', isLoggedIn, upload.single('proof'), async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate roomId
        const roomId = String(req.params.roomId || '').substring(0, 100);
        if (!roomId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid room ID' });
        }
        
        if (!req.file) {
            return res.status(400).json({ success: false, errorCode: 'NO_FILE', error: 'No file uploaded' });
        }
        
        // 🛡️ SECURITY: Query timeout
        const chat = await MarketplaceChat.findOne({ roomId }).maxTimeMS(3000);
        if (!chat) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Chat not found' });
        }
        
        // 🛡️ SECURITY: Ownership check
        const isParticipant = 
            chat.buyerId.toString() === req.session.userId.toString() || 
            chat.sellerId.toString() === req.session.userId.toString();
        
        if (!isParticipant) {
            return res.status(403).json({ success: false, errorCode: 'NOT_AUTHORIZED', error: 'Not authorized' });
        }
        
        let imageUrl = '';
        if (cloudinary && req.file) {
            const result = await uploadToCloudinary(req.file);
            imageUrl = String(result.secure_url || '').substring(0, 500);
        }
        
        chat.paymentProofs.push({
            imageUrl,
            uploadedBy: req.session.userId,
            status: 'Pending',
            uploadedAt: new Date()
        });
        await chat.save();
        
        res.json({ 
            success: true, 
            message: 'Payment proof uploaded',
            paymentProof: chat.paymentProofs[chat.paymentProofs.length - 1]
        });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Payment Proof Error:', {
            msg: err.message,
            roomId: req.params.roomId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to upload payment proof' });
    }
});

// ============================================
// ✅ NAYA: ORDER APIs
// ============================================

// Create order from marketplace
router.post('/api/order/create', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Sanitize inputs
        const productId = String(req.body.productId || '').substring(0, 50);
        const customerName = String(req.body.customerName || '').trim().substring(0, 100);
        const customerMobile = String(req.body.customerMobile || '').trim().substring(0, 10);
        const altMobile = String(req.body.altMobile || '').trim().substring(0, 10);
        const customerAddress = String(req.body.customerAddress || '').trim().substring(0, 500);
        const landmark = String(req.body.landmark || '').trim().substring(0, 200);
        const buyerPincode = String(req.body.buyerPincode || '').trim().substring(0, 6);
        const customerEmail = String(req.body.customerEmail || '').trim().toLowerCase().substring(0, 100);
        const buyQuantity = Math.min(Math.max(parseInt(req.body.buyQuantity) || 1, 1), 10);

        // Validation
        if (!productId || !customerName || !customerMobile || !customerAddress) {
            return res.status(400).json({ success: false, errorCode: 'MISSING_FIELDS', error: 'All fields required: Name, Mobile, Address' });
        }

        if (!/^[6-9]\d{9}$/.test(customerMobile)) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_MOBILE', error: 'Invalid mobile number' });
        }

        // 🛡️ SECURITY: Query timeout
        let product = await MarketplaceProduct.findOne({ productId }).maxTimeMS(3000);
        if (!product && !productId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: `#${productId}` }).maxTimeMS(3000);
        }
        if (!product && productId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: productId.substring(1) }).maxTimeMS(3000);
        }

        if (!product) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Product not found' });
        }

        if (product.status !== 'Available') {
            return res.status(400).json({ success: false, errorCode: 'UNAVAILABLE', error: 'Product is no longer available' });
        }

        // 🛡️ SECURITY: Anti-fraud
        if (product.sellerId.toString() === req.session.userId.toString()) {
            return res.status(400).json({ success: false, errorCode: 'SELF_PURCHASE', error: 'Cannot buy your own product' });
        }

        const orderId = await Order.generateOrderId();

        const order = new Order({
            orderId,
            productId: product.productId,
            sellerId: product.sellerId,
            buyerId: req.session.userId,
            productName: String(product.title || '').substring(0, 200),
            productPrice: Number(product.price) || 0,
            productImage: String(product.images?.[0]?.url || '').substring(0, 500),
            customerName,
            customerMobile,
            altMobile,
            customerAddress,
            landmark,
            buyerPincode,
            customerEmail,
            paymentMethod: 'Cash on Delivery',
            buyQuantity,
            totalAmount: (Number(product.price) || 0) * buyQuantity,
            isReturnable: product.returnPolicy?.enabled || false,
returnDays: product.returnPolicy?.days || 0,
returnDeadline: product.returnPolicy?.enabled ? 
    new Date(Date.now() + (product.returnPolicy.days || 7) * 24 * 60 * 60 * 1000) : null
        });
        await order.save();

                // ✅ Quantity System - Update product
        product.ordersCount = (Number(product.ordersCount) || 0) + 1;
        product.lastOrderId = orderId;
        product.quantity = Math.max(0, (Number(product.quantity) || 1) - buyQuantity);
        
                // Auto status update based on quantity
        if (product.quantity <= 0) {
            product.status = 'Sold Out';
            product.isActive = false; 
        } else {
            product.status = 'Available';
        }
        await product.save();

        // 🛡️ SECURITY: Query timeout
        const chat = await MarketplaceChat.findOne({
            productId: product.productId,
            buyerId: req.session.userId,
            sellerId: product.sellerId
        }).maxTimeMS(3000);

        if (chat) {
            chat.hasOrder = true;
            chat.orderId = orderId;
            await chat.save();
        }

        console.log('✅ Order created:', orderId);
        
        res.json({
            success: true,
            message: 'Order placed successfully!',
            order: {
                orderId: order.orderId,
                status: order.status,
                productName: order.productName,
                totalAmount: Number(order.totalAmount) || 0
            }
        });

    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Create Order Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to place order' });
    }
});

// ✅ Buyer cancel order
router.put('/api/order/:orderId/cancel', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate orderId
        const orderId = String(req.params.orderId || '').substring(0, 50);
        if (!orderId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid order ID' });
        }
        
        const User = require('../models/User');
        
        // 🛡️ SECURITY: Query timeout + ownership check
        const order = await Order.findOne({ 
            orderId, 
            buyerId: req.session.userId 
        }).maxTimeMS(3000);
        
        if (!order) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Order not found' });
        }
        
        if (!['Pending', 'Confirmed'].includes(order.status)) {
            return res.status(400).json({ 
                success: false, 
                errorCode: 'INVALID_STATUS',
                error: 'Cannot cancel - order is already ' + order.status 
            });
        }
        
        // 🛡️ SECURITY: Query timeout
        const user = await User.findById(req.session.userId)
            .select('username name email')
            .lean()
            .maxTimeMS(3000);
        const userName = String(user?.username || user?.name || req.session.userName || 'Buyer').substring(0, 100);
        
        // Update order
        order.status = 'Cancelled';
        order.cancelledBy = req.session.userId;
        order.cancelledByName = userName;
        order.cancelledAt = new Date();
        order.statusHistory.push({
            status: 'Cancelled',
            timestamp: new Date(),
            note: `Cancelled by ${userName} (Buyer)`
        });
        await order.save();
        
                // ✅ Quantity wapas add on cancel
        const product = await MarketplaceProduct.findOne({ productId: order.productId }).maxTimeMS(3000);
        if (product) {
            product.status = 'Available';
            product.quantity = (Number(product.quantity) || 0) + (order.buyQuantity || 1);
            await product.save();
        }
        
        res.json({ success: true, message: 'Order cancelled successfully' });
        
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Cancel Order Error:', {
            msg: err.message,
            orderId: req.params.orderId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to cancel order' });
    }
});

// Get product's chat roomId (for order notifications)
router.get('/api/product/:productId/chat-room', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate productId
        let searchId = String(req.params.productId || '').substring(0, 50);
        if (!searchId) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid product ID' });
        }
        
        // 🛡️ SECURITY: Query timeout
        let product = await MarketplaceProduct.findOne({ productId: searchId }).lean().maxTimeMS(3000);
        if (!product && !searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: `#${searchId}` }).lean().maxTimeMS(3000);
        }
        if (!product && searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ productId: searchId.substring(1) }).lean().maxTimeMS(3000);
        }

        if (!product) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Product not found' });
        }

        // 🛡️ SECURITY: Query timeout
        const chat = await MarketplaceChat.findOne({
            productId: product.productId,
            buyerId: req.session.userId,
            sellerId: product.sellerId
        }).lean().maxTimeMS(3000);

        res.json({
            success: true,
            roomId: chat?.roomId || null,
            hasChat: !!chat
        });

    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Chat Room Error:', {
            msg: err.message,
            productId: req.params.productId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch chat room' });
    }
});

// Seller: My Products Management Page
router.get('/my-products', isLoggedIn, async (req, res) => {
    res.render('seller/my-products', {
        title: 'My Products - Billexa',
        session: req.session
    });
});

// ✅ Bulk status update
router.put('/api/orders/bulk-update', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate inputs
        const orderIds = req.body.orderIds;
        const status = String(req.body.status || '').substring(0, 30);
        
        if (!orderIds || !Array.isArray(orderIds) || !orderIds.length || !status) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_DATA', error: 'Invalid data' });
        }
        
        // 🛡️ SECURITY: Cap max orders
        if (orderIds.length > 50) {
            return res.status(400).json({ success: false, errorCode: 'TOO_MANY', error: 'Max 50 orders at a time' });
        }
        
        // 🛡️ SECURITY: Sanitize each orderId
        const safeOrderIds = orderIds.map(id => String(id || '').substring(0, 50)).filter(Boolean);
        
        const validStatuses = ['Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];
        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_STATUS', error: 'Invalid status' });
        }
        
        // 🛡️ SECURITY: Query timeout
        const result = await Order.updateMany(
            { orderId: { $in: safeOrderIds }, sellerId: req.session.userId },
            { 
                $set: { status },
                $push: { 
                    statusHistory: { 
                        status, 
                        timestamp: new Date(), 
                        updatedBy: req.session.userId 
                    } 
                }
            }
        ).maxTimeMS(5000);
        
        // ✅ Product status update
        for (const orderId of safeOrderIds) {
            const order = await Order.findOne({ orderId }).maxTimeMS(3000);
            if (!order) continue;
            
            const product = await MarketplaceProduct.findOne({ productId: order.productId }).maxTimeMS(3000);
            if (!product) continue;
            
                        if (status === 'Confirmed') {
                if (product.autoRestock) {
                    product.status = 'Available';
                    await product.save();
                }
            }
            
                       if (status === 'Delivered') {
    if (product.autoRestock) {
        product.status = 'Available';
        product.quantity = product.quantity + (order.buyQuantity || 1);
    }
    product.deliveredCount = (product.deliveredCount || 0) + 1;
    await product.save();
}
            
if (status === 'Cancelled') {
    product.status = 'Available';
    product.quantity = (Number(product.quantity) || 0) + (order.buyQuantity || 1);
    product.cancelledCount = (product.cancelledCount || 0) + 1;
    await product.save();
}}
        res.json({ success: true, updated: result.modifiedCount });
        
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Bulk Update Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to bulk update' });
    }
});

// ✅ Order badge count
router.get('/api/order-badge', isLoggedIn, async (req, res) => {
    try {
        const userId = req.session.userId;
        
        // 🛡️ SECURITY: Query timeout
        const count = await Order.countDocuments({
            $or: [
                { buyerId: userId, status: { $in: ['Confirmed', 'Shipped', 'Out for Delivery'] } },
                { sellerId: userId, status: 'Pending' }
            ]
        }).maxTimeMS(3000);
        
        res.json({ count: Number(count) || 0 });
    } catch(err) {
        // 🛡️ SECURITY: Safe fallback
        res.json({ count: 0 });
    }
});

// ✅ TOGGLE PRODUCT ACTIVE/INACTIVE
router.put('/api/product/:productId/toggle-active', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate + sanitize productId
        let searchId = String(req.params.productId || '').substring(0, 50);
        if (!searchId) {
            return res.status(400).json({ 
                success: false, 
                errorCode: 'INVALID_ID', 
                error: 'Invalid product ID' 
            });
        }
        
        // 🛡️ SECURITY: Find product + check ownership
        let product = await MarketplaceProduct.findOne({ 
            productId: searchId, 
            sellerId: req.session.userId 
        }).maxTimeMS(3000);
        
        // Fallback search
        if (!product && !searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ 
                productId: `#${searchId}`, 
                sellerId: req.session.userId 
            }).maxTimeMS(3000);
        }
        if (!product && searchId.startsWith('#')) {
            product = await MarketplaceProduct.findOne({ 
                productId: searchId.substring(1), 
                sellerId: req.session.userId 
            }).maxTimeMS(3000);
        }
        
        if (!product) {
            return res.status(403).json({ 
                success: false, 
                errorCode: 'NOT_AUTHORIZED', 
                error: 'Product not found or unauthorized' 
            });
        }
        
        // ✅ Toggle isActive
        product.isActive = !product.isActive;
        
        if (product.isActive) {
            product.deactivatedAt = null;
            product.status = 'Available';
        } else {
            product.deactivatedAt = new Date();
            product.status = 'Inactive';
        }
        
        await product.save();
        
        console.log(`🔄 Product ${product.productId} ${product.isActive ? 'Activated' : 'Deactivated'}`);
        
        res.json({
            success: true,
            isActive: product.isActive,
            status: product.status,
            deactivatedAt: product.deactivatedAt,
            message: product.isActive ? '✅ Product Activated Successfully!' : '⏸️ Product Deactivated Successfully!'
        });
        
    } catch (err) {
        console.error('Toggle Active Error:', {
            msg: err.message,
            productId: req.params.productId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ 
            success: false, 
            errorCode: 'SERVER_ERROR', 
            error: 'Failed to toggle product status' 
        });
    }
});

// ✅ GET Seller's Other Products
router.get('/api/seller/:sellerId/products', cacheModule.cacheMiddleware(60), async (req, res) => {
    try {
        const sellerId = String(req.params.sellerId || '').substring(0, 50);
        if (!sellerId) {
            return res.status(400).json({ success: false, error: 'Invalid seller ID' });
        }
        
        // Get current productId to exclude
        const excludeProductId = String(req.query.exclude || '').substring(0, 50);
        
        let query = { 
            sellerId: sellerId,
            isActive: true,
            status: 'Available'
        };
        
        if (excludeProductId) {
            query.productId = { $ne: excludeProductId };
        }
        
        const products = await MarketplaceProduct.find(query)
            .sort({ createdAt: -1 })
            .limit(8)
            .lean()
            .maxTimeMS(3000);
            
        res.json({ success: true, products, count: products.length });
    } catch (err) {
        console.error('Seller Products Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to fetch' });
    }
});

// Seller Products Page
router.get('/seller-products', (req, res) => {
    res.render('seller-products', {
        title: 'Seller Products - Billexa',
        session: req.session || null
    });
});

// ============================================
// ✅ RETURN APIs
// ============================================

// Buyer: Request Return (with Bank Details + Pickup Address + Images)
router.post('/api/order/:orderId/return', isLoggedIn, (req, res, next) => {
    upload.array('returnImages', 3)(req, res, (err) => {
        if (err) {
            if (err.message.includes('Only images allowed')) {
                return res.status(400).json({ success: false, error: 'Only JPG, PNG, WebP images allowed!' });
            }
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ success: false, error: 'File too large. Max 5MB each.' });
            }
            return res.status(400).json({ success: false, error: err.message });
        }
        next();
    });
}, async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '').substring(0, 50);
        const reason = String(req.body.reason || '').trim().substring(0, 500);
        const accountHolder = String(req.body.accountHolder || '').trim().substring(0, 100);
        const accountNumber = String(req.body.accountNumber || '').trim().substring(0, 20);
        const ifscCode = String(req.body.ifscCode || '').trim().toUpperCase().substring(0, 11);
        const bankName = String(req.body.bankName || '').trim().substring(0, 100);
        const pickupAddress = String(req.body.pickupAddress || '').trim().substring(0, 500);
        
        const order = await Order.findOne({ 
            orderId, 
            buyerId: req.session.userId,
            status: 'Delivered',
            isReturnable: true
        }).maxTimeMS(3000);
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'Order not found or not returnable' });
        }
        
        if (order.returnDeadline && new Date() > new Date(order.returnDeadline)) {
            return res.status(400).json({ success: false, error: 'Return window expired' });
        }
        
        // ✅ Upload images to Cloudinary
        const images = [];
        if (cloudinary && req.files && req.files.length > 0) {
            for (const file of req.files) {
                try {
                    const result = await uploadToCloudinary(file);
                    images.push({ 
                        url: String(result.secure_url).substring(0, 500), 
                        publicId: String(result.public_id).substring(0, 100) 
                    });
                } catch (e) {
                    console.error('Return image upload error:', e.message);
                }
            }
        }
        
        // ✅ Save everything with return request
        order.returnRequest = {
            requested: true,
            reason: reason || 'Not specified',
            description: reason || '',
            requestedAt: new Date(),
            status: 'pending',
            pickupAddress: pickupAddress,
            bankDetails: {
                accountHolder: accountHolder,
                accountNumber: accountNumber,
                ifscCode: ifscCode,
                bankName: bankName
            },
            images: images // ✅ Save uploaded images
        };
        order.status = 'Return Requested';
        await order.save();
        
        // ✅ Save last used bank details to User model
        if (accountNumber) {
            const User = require('../models/User');
            await User.findByIdAndUpdate(req.session.userId, {
                lastBankDetails: {
                    accountHolder: accountHolder,
                    accountNumber: accountNumber,
                    ifscCode: ifscCode,
                    bankName: bankName
                }
            });
        }
        
        res.json({ success: true, message: 'Return request submitted!' });
        
    } catch (err) {
        console.error('Return error:', err.message);
        res.status(500).json({ success: false, error: 'Server error' });
    }
});

// Seller: Handle Return (Accept/Reject/Received with UTR + Auto Delete Images)
router.put('/api/order/:orderId/handle-return', isLoggedIn, async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '').substring(0, 50);
        const { action, response, utr, refundAmount } = req.body;
        
        const order = await Order.findOne({ 
            orderId, 
            sellerId: req.session.userId,
            'returnRequest.requested': true,
            'returnRequest.status': { $in: ['pending', 'accepted'] }
        }).maxTimeMS(3000);
        
        if (!order) {
            return res.status(404).json({ success: false, error: 'No pending return request' });
        }
        
        if (action === 'accept') {
            // ✅ Mark as accepted with expected dates
            order.returnRequest.status = 'accepted';
            order.returnRequest.sellerResponse = response || 'Return accepted by seller';
            order.returnRequest.sellerRespondedAt = new Date();
            
            // ✅ Save expected dates from seller
            const pickupDate = req.body.expectedPickupDate || null;
            const refundDate = req.body.expectedRefundDate || null;
            
            if (pickupDate) {
                order.returnRequest.expectedPickupDate = new Date(pickupDate);
            }
            if (refundDate) {
                order.returnRequest.expectedRefundDate = new Date(refundDate);
            }
            
        } else if (action === 'reject') {
            order.returnRequest.status = 'rejected';
            order.returnRequest.sellerResponse = response || 'Return rejected';
            order.status = 'Delivered';
            order.returnRequest.sellerRespondedAt = new Date();
            
            // ✅ Delete return images on reject
            if (cloudinary && order.returnRequest?.images?.length > 0) {
                for (const img of order.returnRequest.images) {
                    if (img.publicId) {
                        cloudinary.uploader.destroy(img.publicId).catch(() => {});
                    }
                }
                order.returnRequest.images = [];
            }
            
        } else if (action === 'received') {
            // ✅ UTR MUST be provided for received
            if (!utr || !utr.trim()) {
                return res.json({ success: false, error: 'UTR number required' });
            }
            order.returnRequest.status = 'approved';
            order.returnRequest.refundUTR = utr.trim();
            order.returnRequest.refundAmount = refundAmount || order.totalAmount;
            order.returnRequest.refundedAt = new Date();
            order.returnRequest.sellerResponse = response || 'Item received & refunded';
            order.status = 'Return Approved';
            order.returnRequest.sellerRespondedAt = new Date();
            
            // ✅ Delete return images on refund success
            if (cloudinary && order.returnRequest?.images?.length > 0) {
                for (const img of order.returnRequest.images) {
                    if (img.publicId) {
                        cloudinary.uploader.destroy(img.publicId).catch(() => {});
                    }
                }
                order.returnRequest.images = [];
            }
            
        } else {
            return res.json({ success: false, error: 'Invalid action. Use accept, reject or received' });
        }
        
        await order.save();
        
        res.json({ success: true, message: `Return ${action}ed!` });
        
    } catch (err) {
        console.error('Handle return error:', err);
        res.status(500).json({ success: false, error: 'Failed' });
    }
});

// ✅ SELLER: Save Pickup Address
router.put('/api/order/:orderId/pickup-address', isLoggedIn, async (req, res) => {
    try {
        const orderId = String(req.params.orderId || '').substring(0, 50);
        const pickupAddress = String(req.body.pickupAddress || '').trim().substring(0, 500);
        
        if (!pickupAddress || pickupAddress.length < 10) {
            return res.status(400).json({ 
                success: false, 
                error: 'Please enter complete address (min 10 characters)' 
            });
        }
        
        // Find order + check seller ownership
        const order = await Order.findOne({ 
            orderId, 
            sellerId: req.session.userId 
        }).maxTimeMS(3000);
        
        if (!order) {
            return res.status(404).json({ 
                success: false, 
                error: 'Order not found or unauthorized' 
            });
        }
        
        // Save pickup address
        order.pickupAddress = pickupAddress;
        order.pickupAddressAddedAt = new Date();
        
        order.statusHistory.push({
            status: order.status,
            timestamp: new Date(),
            note: 'Pickup address added by seller'
        });
        
        await order.save();
        
        console.log('📍 Pickup address saved for:', orderId);
        
        res.json({ 
            success: true, 
            message: 'Pickup address saved successfully!',
            pickupAddress: order.pickupAddress 
        });
        
    } catch (err) {
        console.error('Pickup Address Error:', err.message);
        res.status(500).json({ success: false, error: 'Failed to save address' });
    }
});
module.exports = router;
