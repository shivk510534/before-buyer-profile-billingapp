const express = require('express');
const router = express.Router();
const PDFDocument = require('pdfkit');
const Order = require('../models/Order');
const MarketplaceProduct = require('../models/MarketplaceProduct');

// Auth middleware
function isLoggedIn(req, res, next) {
    // 🛡️ SECURITY: Validate session properly
    if (!req.session || !req.session.userId) {
        return res.status(401).json({ 
            success: false, 
            errorCode: 'AUTH_REQUIRED',
            error: 'Login required' 
        });
    }
    
    // 🛡️ SECURITY: Validate userId format
    if (typeof req.session.userId !== 'string' || req.session.userId.length > 50) {
        return res.status(401).json({ 
            success: false, 
            errorCode: 'INVALID_SESSION',
            error: 'Invalid session' 
        });
    }
    
    next();
}

// Helper: Format Indian date
function formatIndianDate(date) {
    return new Date(date).toLocaleDateString('en-IN', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    });
}

// ==================== PAGES ====================

router.get('/track', (req, res) => {
    res.render('orders/track', {
        title: 'Track Order - Marketplace',
        session: req.session || null
    });
});

router.get('/my', isLoggedIn, (req, res) => {
    res.render('orders/my-orders', {
        title: 'My Orders - Marketplace',
        session: req.session || null
    });
});

router.get('/detail/:orderId', isLoggedIn, (req, res) => {
    res.render('orders/detail', {
        title: 'Order Details - Marketplace',
        session: req.session || null,
        orderId: req.params.orderId
    });
});

// ==================== API ROUTES ====================
// ✅ IMPORTANT: Fixed routes pehle, dynamic routes baad me

// Get My Orders - FIXED route BEFORE /api/orders/:orderId
router.get('/api/orders/my/list', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Whitelist type filter
        const allowedTypes = ['buyer', 'seller', 'all'];
        const type = allowedTypes.includes(req.query.type) ? req.query.type : 'all';
        
        let query = {};
        
        if (type === 'buyer') {
            query = { buyerId: req.session.userId };
        } else if (type === 'seller') {
            query = { sellerId: req.session.userId };
        } else {
            query = {
                $or: [
                    { buyerId: req.session.userId },
                    { sellerId: req.session.userId }
                ]
            };
        }
        
        // 🛡️ SECURITY: Query timeout + limit
        const orders = await Order.find(query)
            .sort({ createdAt: -1 })
            .lean()
            .maxTimeMS(5000)
            .limit(200);

        const formattedOrders = orders.map(order => ({
            ...order,
            createdAtFormatted: formatIndianDate(order.createdAt),
            isSeller: order.sellerId.toString() === req.session.userId.toString(),
            isBuyer: order.buyerId.toString() === req.session.userId.toString()
        }));

        res.json({ success: true, orders: formattedOrders });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Orders Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch orders' });
    }
});

// Export Orders as CSV - FIXED route BEFORE /api/orders/:orderId
router.get('/api/orders/my/export/csv', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Whitelist type
        const allowedTypes = ['buyer', 'seller', 'all'];
        const type = allowedTypes.includes(req.query.type) ? req.query.type : 'all';
        
        let query = {};
        if (type === 'buyer') query = { buyerId: req.session.userId };
        else if (type === 'seller') query = { sellerId: req.session.userId };
        else query = { $or: [{ buyerId: req.session.userId }, { sellerId: req.session.userId }] };
        
        // 🛡️ SECURITY: Query timeout + limit
        const orders = await Order.find(query).sort({ createdAt: -1 }).lean().maxTimeMS(5000).limit(200);
        
        let csv = 'Order ID,Product,Price,Customer Name,Mobile,Address,Status,Payment,Date,Role\n';
        
        orders.forEach(order => {
            const role = order.buyerId.toString() === req.session.userId.toString() ? 'Buyer' : 'Seller';
            const row = [
                String(order.orderId || '').replace(/[=,@+\-]/g, ' ').substring(0, 50),
                `"${String(order.productName || '').replace(/"/g, '""').substring(0, 200)}"`,
                Number(order.totalAmount) || 0,
                `"${String(order.customerName || '').replace(/"/g, '""').substring(0, 100)}"`,
                String(order.customerMobile || '').replace(/\D/g, '').substring(0, 10),
                `"${String(order.customerAddress || '').replace(/"/g, '""').substring(0, 300)}"`,
                String(order.status || '').substring(0, 20),
                String(order.paymentMethod || '').substring(0, 20),
                new Date(order.createdAt).toLocaleDateString('en-IN'),
                role
            ].join(',');
            csv += row + '\n';
        });
        
        // 🛡️ SECURITY: Safe filename + headers
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="my-orders-${Date.now()}.csv"`);
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.send('\uFEFF' + csv);
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Export CSV Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to export CSV' });
    }
});

// Export Orders as PDF - FIXED route BEFORE /api/orders/:orderId
router.get('/api/orders/my/export/pdf', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Whitelist type
        const allowedTypes = ['buyer', 'seller', 'all'];
        const type = allowedTypes.includes(req.query.type) ? req.query.type : 'all';
        
        let query = {};
        if (type === 'buyer') query = { buyerId: req.session.userId };
        else if (type === 'seller') query = { sellerId: req.session.userId };
        else query = { $or: [{ buyerId: req.session.userId }, { sellerId: req.session.userId }] };
        
        // 🛡️ SECURITY: Query timeout + limit
        const orders = await Order.find(query).sort({ createdAt: -1 }).lean().maxTimeMS(5000).limit(200);
        const doc = new PDFDocument({ size: 'A4', margin: 30, layout: 'landscape' });
        
        // 🛡️ SECURITY: Safe filename
        const safeFilename = `my-orders-${Date.now()}.pdf`;
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
        doc.pipe(res);
        
        doc.rect(0, 0, doc.page.width, 80).fill('#0a0a0a');
        doc.fillColor('#00ff00').fontSize(22).font('Helvetica-Bold').text('My Orders Report', 30, 25);
        doc.fillColor('#888').fontSize(10).text(`Generated: ${formatIndianDate(new Date())}`, 30, 55);
        
        let y = 100;
        const cols = [
            { x: 30, w: 120, label: 'Order ID' }, { x: 150, w: 160, label: 'Product' },
            { x: 310, w: 80, label: 'Amount' }, { x: 390, w: 110, label: 'Customer' },
            { x: 500, w: 100, label: 'Status' }, { x: 600, w: 90, label: 'Date' },
            { x: 690, w: 60, label: 'Role' }
        ];
        
        doc.rect(30, y, doc.page.width - 60, 20).fill('#00ff00');
        doc.fillColor('#000').fontSize(9).font('Helvetica-Bold');
        cols.forEach(c => doc.text(c.label, c.x + 5, y + 5));
        y += 25;
        
        doc.font('Helvetica').fontSize(8);
        orders.forEach((order, i) => {
            if (y > doc.page.height - 60) {
                doc.addPage();
                y = 50;
                doc.rect(30, y, doc.page.width - 60, 20).fill('#00ff00');
                doc.fillColor('#000').fontSize(9).font('Helvetica-Bold');
                cols.forEach(c => doc.text(c.label, c.x + 5, y + 5));
                doc.font('Helvetica').fontSize(8);
                y += 25;
            }
            
            doc.rect(30, y, doc.page.width - 60, 18).fill(i % 2 === 0 ? '#1a1a1a' : '#0f0f0f');
            
            const role = order.buyerId.toString() === req.session.userId.toString() ? 'Buyer' : 'Seller';
            // 🛡️ SECURITY: Truncate text for PDF
            const values = [
                String(order.orderId || '').substring(0, 20),
                String(order.productName || '').substring(0, 25),
                '₹' + (Number(order.totalAmount) || 0).toLocaleString('en-IN'),
                String(order.customerName || '').substring(0, 18),
                String(order.status || '').substring(0, 15),
                new Date(order.createdAt).toLocaleDateString('en-IN'),
                role
            ];
            
            doc.fillColor('#fff');
            values.forEach((v, idx) => doc.text(v, cols[idx].x + 5, y + 4));
            y += 20;
        });
        
        doc.fillColor('#00ff00').fontSize(8).text(`Total Orders: ${orders.length}`, 30, doc.page.height - 40);
        doc.fillColor('#888').text('Billing SaaS - Marketplace Report', 30, doc.page.height - 25);
        doc.end();
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Export PDF Error:', {
            msg: err.message,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to export PDF' });
    }
});

// Create Order
router.post('/api/orders/create', isLoggedIn, async (req, res) => {
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

        if (!productId || !customerName || !customerMobile || !customerAddress) {
            return res.status(400).json({ success: false, errorCode: 'MISSING_FIELDS', error: 'All fields are required' });
        }

        if (!/^[6-9]\d{9}$/.test(customerMobile)) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_MOBILE', error: 'Invalid mobile number' });
        }

        // 🛡️ SECURITY: Query timeout
        const product = await MarketplaceProduct.findOne({ productId }).maxTimeMS(3000);
        if (!product) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Product not found' });
        }

        if (product.status !== 'Available') {
            return res.status(400).json({ success: false, errorCode: 'UNAVAILABLE', error: 'Product is no longer available' });
        }

        // 🛡️ SECURITY: Anti-fraud - prevent self-purchase
        if (product.sellerId.toString() === req.session.userId.toString()) {
            return res.status(400).json({ success: false, errorCode: 'SELF_PURCHASE', error: 'You cannot buy your own product' });
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

// Track Order (Public)
router.post('/api/orders/track', async (req, res) => {
    try {
        // 🛡️ SECURITY: Sanitize inputs
        const orderId = String(req.body.orderId || '').trim().toUpperCase().substring(0, 50);
        const mobile = String(req.body.mobile || '').trim().substring(0, 10);

        if (!orderId || !mobile) {
            return res.status(400).json({ success: false, errorCode: 'MISSING_FIELDS', error: 'Order ID and Mobile are required' });
        }

        // 🛡️ SECURITY: Validate mobile format
        if (!/^\d{10}$/.test(mobile)) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_MOBILE', error: 'Invalid mobile number' });
        }

        // 🛡️ SECURITY: Query timeout
        const order = await Order.findOne({
            orderId,
            customerMobile: mobile
        }).lean().maxTimeMS(3000);

        if (!order) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Order not found. Please check your Order ID and Mobile number.' });
        }

        order.createdAtFormatted = formatIndianDate(order.createdAt);
        order.statusHistory = order.statusHistory.map(h => ({
            ...h,
            timestampFormatted: formatIndianDate(h.timestamp)
        }));

        res.json({ success: true, order });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Track Order Error:', {
            msg: err.message,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to track order' });
    }
});

// ✅ Get Order Details - DYNAMIC route LAST me rakha
router.get('/api/orders/:orderId', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate orderId
        const orderId = String(req.params.orderId || '').substring(0, 50);
        
        // Skip if matches known paths
        if (['my', 'track', 'create'].includes(orderId)) {
            return res.status(404).json({ success: false, errorCode: 'INVALID_ID', error: 'Invalid order ID' });
        }

        // 🛡️ SECURITY: Query timeout
        const order = await Order.findOne({
            orderId,
            $or: [
                { buyerId: req.session.userId },
                { sellerId: req.session.userId }
            ]
        }).lean().maxTimeMS(3000);

        if (!order) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Order not found' });
        }

        order.createdAtFormatted = formatIndianDate(order.createdAt);
        order.statusHistory = order.statusHistory.map(h => ({
            ...h,
            timestampFormatted: formatIndianDate(h.timestamp)
        }));

        order.isBuyer = order.buyerId.toString() === req.session.userId.toString();
        order.isSeller = order.sellerId.toString() === req.session.userId.toString();

        res.json({ success: true, order });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Get Order Error:', {
            msg: err.message,
            orderId: req.params.orderId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to fetch order' });
    }
});

// Update Order Status
router.put('/api/orders/:orderId/status', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate inputs
        const orderId = String(req.params.orderId || '').substring(0, 50);
        const status = String(req.body.status || '').substring(0, 30);
        
        const validStatuses = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered', 'Cancelled'];

        if (!validStatuses.includes(status)) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_STATUS', error: 'Invalid status' });
        }

        // 🛡️ SECURITY: Query timeout
        const order = await Order.findOne({
            orderId,
            $or: [
                { sellerId: req.session.userId },
                ...(req.session.isAdmin ? [{}] : [])
            ]
        }).maxTimeMS(3000);

        if (!order) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Order not found or unauthorized' });
        }

        // 🛡️ SECURITY: Status transition validation
        if (!req.session.isAdmin) {
            const statusOrder = ['Pending', 'Confirmed', 'Packed', 'Shipped', 'Out for Delivery', 'Delivered'];
            const currentIndex = statusOrder.indexOf(order.status);
            const newIndex = statusOrder.indexOf(status);

            if (status !== 'Cancelled' && newIndex <= currentIndex) {
                return res.status(400).json({ success: false, errorCode: 'INVALID_TRANSITION', error: 'Invalid status transition' });
            }
        }

        order.status = status;
        order.statusHistory.push({
            status,
            timestamp: new Date(),
            updatedBy: req.session.userId
        });

        await order.save();
// ✅ AUTO RESTOCK LOGIC - Confirmed pe Available!
        if (status === 'Confirmed') {
            const product = await MarketplaceProduct.findOne({ productId: order.productId }).maxTimeMS(3000);
            if (product && product.autoRestock) {
                product.status = 'Available';
                await product.save();
                console.log('🔄 Auto Restock (Confirmed): ' + product.productId + ' → Available');
            }
        }
if (status === 'Delivered') {
    const product = await MarketplaceProduct.findOne({ productId: order.productId }).maxTimeMS(3000);
    if (product) {
        if (product.autoRestock) {
            product.status = 'Available';
            product.quantity = product.quantity + (order.buyQuantity || 1);
        }
        product.deliveredCount = (product.deliveredCount || 0) + 1;
        await product.save();
    }
}

                if (status === 'Cancelled') {
    const product = await MarketplaceProduct.findOne({ productId: order.productId }).maxTimeMS(3000);
    if (product) {
        product.status = 'Available';
        product.quantity = (Number(product.quantity) || 0) + (order.buyQuantity || 1);
        product.cancelledCount = (product.cancelledCount || 0) + 1;
        await product.save();
    }
}
        res.json({ success: true, message: `Order status updated to ${status}`, order });
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Update Status Error:', {
            msg: err.message,
            orderId: req.params.orderId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to update status' });
    }
});

// Generate Invoice PDF - PROFESSIONAL (With UDYAM + KYC SIGNATURE)
router.get('/api/invoice/order/:orderId/pdf', isLoggedIn, async (req, res) => {
    try {
        const Order = require('../models/Order');
        const User = require('../models/User');
        const SellerKYC = require('../models/SellerKYC');
        
        // 🛡️ SECURITY: Validate orderId + query timeout
        const orderId = String(req.params.orderId || '').substring(0, 50);
        
        const order = await Order.findOne({
            orderId,
            $or: [
                { buyerId: req.session.userId },
                { sellerId: req.session.userId }
            ]
        }).maxTimeMS(3000);

        if (!order) {
            return res.status(404).json({ success: false, errorCode: 'NOT_FOUND', error: 'Order not found' });
        }

        const seller = await User.findById(order.sellerId).maxTimeMS(3000);
        const sellerKYC = await SellerKYC.findOne({ userId: order.sellerId }).lean().maxTimeMS(3000);
        
        const PDFDocument = require('pdfkit');
        const path = require('path');
        const fs = require('fs');
        
        const doc = new PDFDocument({ 
            margin: 0,
            size: 'A4',
            layout: 'portrait',
            bufferPages: false
        });
        
        // 🛡️ SECURITY: Safe filename
        const safeOrderId = String(order.orderId || 'order').replace(/[^a-zA-Z0-9_-]/g, '').substring(0, 50);
        const fileName = `Invoice_${safeOrderId}.pdf`;
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
        
        doc.pipe(res);
        
        const pageWidth = 595.28;
        const pageHeight = 841.89;
        const margin = 25;
        const contentWidth = pageWidth - (margin * 2);
        const darkBg = '#0a0a0a';
        const green = '#00cc00';
        const lightGreen = '#eafbea';
        const lightGray = '#f5f5f5';
        const midGray = '#888888';
        const darkGray = '#1a1a1a';
        const textColor = '#222222';
        
                // ========== HEADER (Professional - Seller Details) ==========
        doc.rect(0, 0, pageWidth, 115).fill(darkBg);
        doc.rect(0, 113, pageWidth, 3).fill(green);
        
        // Business Logo (if exists)
        let logoDrawn = false;
        if (seller?.businessLogo) {
            try {
                const logoBuffer = await new Promise((resolve) => {
                    const client = seller.businessLogo.startsWith('https') ? require('https') : require('http');
                    client.get(seller.businessLogo, (response) => {
                        if (response.statusCode !== 200) return resolve(null);
                        const chunks = [];
                        response.on('data', chunk => chunks.push(chunk));
                        response.on('end', () => resolve(Buffer.concat(chunks)));
                    }).on('error', () => resolve(null));
                });
                if (logoBuffer && logoBuffer.length > 100) {
                    doc.image(logoBuffer, margin, 20, { width: 50, height: 50 });
                    logoDrawn = true;
                }
            } catch(e) {}
        }
        
        const logoPath = path.join(__dirname, '..', 'public', 'logo.png');
        if (!logoDrawn && fs.existsSync(logoPath)) {
            doc.image(logoPath, margin, 20, { width: 50, height: 50 });
            logoDrawn = true;
        }
        
        const businessName = seller?.businessName || seller?.username || 'Seller';
        const nameX = logoDrawn ? margin + 62 : margin;
        
        doc.fontSize(22).font('Helvetica-Bold').fillColor(green).text(businessName, nameX, 18);
        doc.fontSize(7.5).font('Helvetica').fillColor('#aaaaaa').text('Tax Invoice / Bill of Supply', nameX, 44);
        
        let contactLine = '';
        if (seller?.email) contactLine += 'Email: ' + seller.email;
        doc.fontSize(7).font('Helvetica').fillColor('#bbbbbb').text(contactLine || '', nameX, 60);
        
        if (seller?.businessAddress) {
            doc.fontSize(7).font('Helvetica').fillColor('#999999').text('Address: ' + seller.businessAddress, nameX, 74);
        }
        
        if (seller?.gstNumber) {
            doc.fontSize(7).font('Helvetica').fillColor('#888888').text('GSTIN: ' + seller.gstNumber, nameX, 88);
        }
        
        // Invoice Badge
        doc.roundedRect(pageWidth - margin - 140, 20, 140, 48, 6).fill(green);
        doc.fontSize(20).font('Helvetica-Bold').fillColor(darkBg).text('INVOICE', pageWidth - margin - 132, 26);
        doc.fontSize(7.5).font('Helvetica').fillColor(darkBg).text('#' + safeOrderId, pageWidth - margin - 132, 48);
        doc.fontSize(7.5).font('Helvetica').fillColor('#cccccc')
           .text('Date: ' + new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }), 
                 pageWidth - margin - 140, 74, { width: 140, align: 'right' });
        
        let y = 140;
        
        doc.fontSize(10).font('Helvetica-Bold').fillColor(darkGray).text('INVOICE DETAILS', margin, y);
        doc.rect(margin, y + 14, 50, 2.5).fill(green);
        y += 28;
        
        const colWidth = (contentWidth / 2) - 10;
        const col1X = margin;
        const col2X = margin + colWidth + 20;
        
                // LEFT: Bill From - 🛡️ SECURITY: Sanitize text
        doc.roundedRect(col1X, y, colWidth, 95, 4).fill('#fafafa').stroke('#e0e0e0');
        doc.rect(col1X, y, colWidth, 4).fill(green);
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(green).text('BILL FROM (Seller)', col1X + 12, y + 10);
        doc.fontSize(9).font('Helvetica-Bold').fillColor(darkGray)
           .text(String(seller?.businessName || seller?.username || 'Seller').substring(0, 50), col1X + 12, y + 26);
        doc.fontSize(7.5).font('Helvetica').fillColor(midGray)
           .text(String(seller?.email || 'N/A').substring(0, 60), col1X + 12, y + 44);
        
        if (seller?.gstNumber) {
            doc.fontSize(7).font('Helvetica-Bold').fillColor(green)
               .text('GST: ' + String(seller.gstNumber).substring(0, 15), col1X + 12, y + 72);
        }
        
        if (sellerKYC && sellerKYC.status === 'verified') {
            doc.fontSize(7).font('Helvetica-Bold').fillColor(green).text('KYC: Verified', col1X + 12, y + 86);
        } else {
            doc.fontSize(7).font('Helvetica').fillColor('#ff4444').text('KYC: Not Verified', col1X + 12, y + 86);
        }
        
        // RIGHT: Bill To - 🛡️ SECURITY: Sanitize text
doc.roundedRect(col2X, y, colWidth, 120, 4).fill('#fafafa').stroke('#e0e0e0');
doc.rect(col2X, y, colWidth, 4).fill(green);
doc.fontSize(7.5).font('Helvetica-Bold').fillColor(green).text('BILL TO (Customer)', col2X + 12, y + 10);
doc.fontSize(9).font('Helvetica-Bold').fillColor(darkGray)
   .text(String(order.customerName || 'Walk-in Customer').substring(0, 50), col2X + 12, y + 26);

let custY = y + 44;
if (order.customerAddress) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray)
       .text('Address: ' + String(order.customerAddress).substring(0, 100), col2X + 12, custY, { width: colWidth - 24 });
    custY += 16;
}
if (order.landmark) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray)
       .text('Landmark: ' + String(order.landmark).substring(0, 50), col2X + 12, custY, { width: colWidth - 24 });
    custY += 14;
}
if (order.buyerPincode) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray)
       .text('Pincode: ' + String(order.buyerPincode).substring(0, 6), col2X + 12, custY);
    custY += 14;
}
if (order.customerMobile) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray).text('Mobile: ' + String(order.customerMobile).substring(0, 10), col2X + 12, custY);
    custY += 14;
}
if (order.altMobile) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray).text('Alt Mobile: ' + String(order.altMobile).substring(0, 10), col2X + 12, custY);
    custY += 14;
}
if (order.customerEmail) {
    doc.fontSize(7.5).font('Helvetica').fillColor(midGray).text('Email: ' + String(order.customerEmail).substring(0, 60), col2X + 12, custY);
    custY += 14;
}

y += 130;
        
                // Invoice Meta
        doc.roundedRect(margin, y, contentWidth, 38, 4).fill(lightGray);
        doc.rect(margin, y, contentWidth, 3).fill(green);
        
        const metaData = [
            { label: 'Invoice Date', value: new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'long', year: 'numeric' }) },
            { label: 'Payment Mode', value: String(order.paymentMethod || 'Cash on Delivery').substring(0, 30) },
            { label: 'Order ID', value: safeOrderId },
            { label: 'Status', value: String(order.status || 'Paid').substring(0, 20) }
        ];
        
        const metaWidth = (contentWidth / 4) - 10;
        metaData.forEach((item, i) => {
            const mx = margin + 10 + (i * (contentWidth / 4));
            doc.fontSize(6.5).font('Helvetica-Bold').fillColor(green)
               .text(item.label, mx, y + 10, { width: metaWidth, align: 'center' });
            doc.fontSize(8).font('Helvetica').fillColor(darkGray)
               .text(item.value, mx, y + 22, { width: metaWidth, align: 'center' });
        });
        
        y += 55;
        
        // Products Table
        doc.fontSize(10).font('Helvetica-Bold').fillColor(darkGray).text('PRODUCTS & SERVICES', margin, y);
        doc.rect(margin, y + 14, 50, 2.5).fill(green);
        y += 26;
        
        doc.roundedRect(margin, y, contentWidth, 24, 3).fill(darkBg);
        
        const tableCols = [
            { x: margin + 8, w: 25, label: '#', align: 'left' },
            { x: margin + 40, w: 195, label: 'Product / Service Name', align: 'left' },
            { x: margin + 248, w: 55, label: 'Qty', align: 'center' },
            { x: margin + 312, w: 85, label: 'Rate', align: 'right' },
            { x: margin + 406, w: 100, label: 'Amount', align: 'right' }
        ];
        
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#fff');
        tableCols.forEach(col => doc.text(col.label, col.x, y + 5, { width: col.w - 10, align: col.align }));
        y += 28;
        
        doc.fontSize(8).font('Helvetica');
        doc.roundedRect(margin, y - 2, contentWidth, 20, 2).fill(lightGreen);
        
        doc.fillColor(textColor);
        doc.text('1', tableCols[0].x, y, { width: tableCols[0].w, align: tableCols[0].align });
        doc.text(String(order.productName || 'Product').substring(0, 35), tableCols[1].x, y, { width: tableCols[1].w, align: tableCols[1].align });
        doc.text(String(order.buyQuantity || 1), tableCols[2].x, y, { width: tableCols[2].w, align: tableCols[2].align });
        doc.text('Rs. ' + (Number(order.productPrice) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }), tableCols[3].x, y, { width: tableCols[3].w, align: tableCols[3].align });
        doc.text('Rs. ' + (Number(order.totalAmount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }), tableCols[4].x, y, { width: tableCols[4].w, align: tableCols[4].align });
        
        y += 30;
        
        // Totals
        const totalsX = margin + (contentWidth * 0.55);
        const totalsW = contentWidth * 0.45;
        
        doc.fontSize(8.5).font('Helvetica').fillColor(midGray).text('Subtotal', totalsX, y, { width: totalsW - 100, align: 'right' });
        doc.fontSize(8.5).fillColor(darkGray).text('Rs. ' + (Number(order.totalAmount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }), totalsX + totalsW - 105, y, { width: 100, align: 'right' });
        y += 16;
        doc.moveTo(totalsX, y).lineTo(margin + contentWidth, y).strokeColor('#cccccc').lineWidth(0.5).stroke();
        y += 8;
        
        doc.roundedRect(totalsX, y - 3, totalsW, 34, 5).fill(darkBg).stroke(green).lineWidth(1.5);
        doc.fontSize(10).font('Helvetica-Bold').fillColor(green).text('TOTAL', totalsX + 15, y + 6);
        doc.fontSize(17).font('Helvetica-Bold').fillColor(green)
           .text('Rs. ' + (Number(order.totalAmount) || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 }), totalsX + totalsW - 125, y + 2, { width: 115, align: 'right' });
        
        y += 46;

        // Amount in Words
        const numToWords = (n) => {
            const ones = ['','One','Two','Three','Four','Five','Six','Seven','Eight','Nine','Ten','Eleven','Twelve','Thirteen','Fourteen','Fifteen','Sixteen','Seventeen','Eighteen','Nineteen'];
            const tens = ['','','Twenty','Thirty','Forty','Fifty','Sixty','Seventy','Eighty','Ninety'];
            function convertHundreds(num) {
                if (num === 0) return '';
                if (num < 20) return ones[num];
                if (num < 100) return tens[Math.floor(num/10)] + (num%10 ? ' ' + ones[num%10] : '');
                return ones[Math.floor(num/100)] + ' Hundred' + (num%100 ? ' ' + convertHundreds(num%100) : '');
            }
            if (n === 0) return 'Zero';
            let result = '', crore = Math.floor(n / 10000000), lakh = Math.floor((n % 10000000) / 100000), thousand = Math.floor((n % 100000) / 1000), hundred = n % 1000;
            if (crore) result += convertHundreds(crore) + ' Crore ';
            if (lakh) result += convertHundreds(lakh) + ' Lakh ';
            if (thousand) result += convertHundreds(thousand) + ' Thousand ';
            if (hundred) result += convertHundreds(hundred);
            return result.trim();
        };
        
        const amount = Math.floor(Number(order.totalAmount) || 0);
        const words = numToWords(amount);
        
        doc.roundedRect(margin, y, contentWidth, 24, 3).fill(lightGray);
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(green).text('Amount in Words:', margin + 12, y + 6, { width: 100 });
        doc.fontSize(8.5).font('Helvetica').fillColor(darkGray).text(words + ' Rupees Only', margin + 115, y + 6, { width: contentWidth - 130 });
        
        y += 40;
        
        // ========== KYC VERIFIED SIGNATURE ==========
        if (sellerKYC && sellerKYC.status === 'verified' && sellerKYC.signature && sellerKYC.signature.url) {
            doc.fontSize(8.5).font('Helvetica-Bold').fillColor(darkGray).text('Verified Seller Signature', margin, y);
            doc.rect(margin, y + 14, 50, 2).fill(green);
            y += 22;
            
            try {
                const https = require('https');
                // 🛡️ SECURITY: Validate URL + timeout
                const sigUrl = String(sellerKYC.signature.url).substring(0, 500);
                if (sigUrl.startsWith('http')) {
                    const sigBuffer = await new Promise((resolve) => {
                        const req = https.get(sigUrl, { timeout: 10000 }, (res) => {
                            if (res.statusCode !== 200) { resolve(null); return; }
                            const chunks = [];
                            res.on('data', c => chunks.push(c));
                            res.on('end', () => resolve(Buffer.concat(chunks)));
                        });
                        req.on('error', () => resolve(null));
                        req.setTimeout(10000, () => { req.destroy(); resolve(null); });
                    });
                    
                    if (sigBuffer) {
                        doc.image(sigBuffer, margin, y, { width: 130, height: 50 });
                        y += 58;
                        doc.fontSize(7).font('Helvetica').fillColor(green)
                           .text('KYC Verified Seller | Trust Score: ' + (Number(sellerKYC.trustScore) || 30) + '/100', margin, y);
                        y += 15;
                    }
                }
            } catch(e) {}
        }
        
        y += 5;
        
                // ========== TERMS ==========
        doc.fontSize(8.5).font('Helvetica-Bold').fillColor(darkGray).text('Terms & Conditions', margin, y);
        y += 14;
        doc.fontSize(7).font('Helvetica').fillColor(midGray)
           .text('This is a computer generated invoice and does not require a physical signature.', margin, y)
           .text('Payment is due upon receipt of this invoice.', margin, y + 14)
           .text('For any billing related queries, please contact admin@covexa.in', margin, y + 28);
        
        // ========== FOOTER ==========
        const footerY = pageHeight - 50;
        
        doc.rect(0, footerY, pageWidth, 50).fill('#0a0a0a');
        doc.rect(0, footerY, pageWidth, 3).fill(green);
        
        if (fs.existsSync(logoPath)) {
            doc.image(logoPath, margin, footerY + 12, { width: 28, height: 28 });
        }
        
        const footerTextX = fs.existsSync(logoPath) ? margin + 35 : margin;
        
        // Left - Billexa Branding
        doc.fontSize(8).font('Helvetica-Bold').fillColor('#00cc00')
           .text('Billexa', footerTextX, footerY + 8);
        doc.fontSize(6).font('Helvetica').fillColor('#66aa66')
           .text('Smart Billing Solution', footerTextX, footerY + 20);
        doc.fontSize(5.5).font('Helvetica').fillColor('#558855')
           .text('www.billexa.in', footerTextX, footerY + 30);
        
        // Center
        doc.fontSize(6).font('Helvetica').fillColor('#558855')
           .text('Made in India', 0, footerY + 15, { width: pageWidth, align: 'center' });
        doc.fontSize(5.5).font('Helvetica').fillColor('#446644')
           .text('UDYAM-RJ-01-0157138 | MSME Registered', 0, footerY + 26, { width: pageWidth, align: 'center' });
        
        // Right
        doc.fontSize(6).font('Helvetica').fillColor('#66aa66')
           .text('Computer Generated Invoice', pageWidth - margin - 140, footerY + 12, { width: 130, align: 'right' });
        doc.fontSize(5.5).font('Helvetica').fillColor('#558855')
           .text('admin@covexa.in', pageWidth - margin - 140, footerY + 22, { width: 130, align: 'right' });
        
        doc.end();
        
    } catch (err) {
        // 🛡️ SECURITY: Safe error
        console.error('Invoice PDF Error:', {
            msg: err.message,
            orderId: req.params.orderId,
            userId: req.session?.userId,
            time: new Date().toISOString()
        });
        res.status(500).json({ success: false, errorCode: 'SERVER_ERROR', error: 'Failed to generate invoice' });
    }
});

// ✅ Bulk status update
router.put('/api/orders/bulk-update', isLoggedIn, async (req, res) => {
    try {
        // 🛡️ SECURITY: Validate + sanitize inputs
        const orderIds = req.body.orderIds;
        const status = String(req.body.status || '').substring(0, 30);
        
        if (!orderIds || !Array.isArray(orderIds) || !orderIds.length || !status) {
            return res.status(400).json({ success: false, errorCode: 'INVALID_DATA', error: 'Invalid data' });
        }
        
        // 🛡️ SECURITY: Cap max orders for bulk update
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
        
        // ✅ Product status update for ALL statuses
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
    await product.save();
}
            
                        if (status === 'Cancelled') {
                product.status = 'Available';
                product.quantity = (Number(product.quantity) || 0) + (order.buyQuantity || 1); // ✅ Wapas add
                await product.save();
            }
        }
        
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

module.exports = router;
