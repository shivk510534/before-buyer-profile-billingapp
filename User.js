const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  // ============================================
  // 📝 BASIC INFO
  // ============================================
  username: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  mobile: { type: String, required: true, unique: true, trim: true },
  password: { type: String, required: true },
  dob: { type: String },
  gender: { type: String, enum: ['Male', 'Female', 'Other', ''] },
  ip: { type: String },
  lastActive: { type: Date, default: Date.now },
  termsAccepted: { type: Boolean, default: false },
  termsAcceptedAt: { type: Date },
activeSessionId: { type: String, default: '' },
  lastSessionUpdate: { type: Date, default: null },
  isEmailVerified: {
  type: Boolean,
  default: false
},

emailVerifyToken: {
  type: String,
  default: null
},
emailVerifyExpires: {
    type: Date,
    default: null
},
emailVerifiedAt: Date,

// ✅ Last Used Bank Details for Returns
lastBankDetails: {
    accountHolder: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    ifscCode: { type: String, default: '' },
    bankName: { type: String, default: '' }
},
  
  // ============================================
  // 🛡️ ADMIN & BAN FIELDS
  // ============================================
  isAdmin: { type: Boolean, default: false },
  isBanned: { type: Boolean, default: false },
  bannedAt: { type: Date, default: null },
  bannedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  banReason: { type: String, default: '' },
  
  // ============================================
  // 🔐 LOCKOUT FIELDS (ALL USERS with 2FA)
  // ============================================
  loginAttempts: { type: Number, default: 0 },
  lastFailedLogin: { type: Date, default: null },
  lockedUntil: { type: Date, default: null },
  
  // ============================================
  // 📸 PROFILE PHOTO FIELDS
  // ============================================
  profilePhoto: { type: String, default: '' },
  profilePhotoId: { type: String, default: '' },
  businessLogo: { type: String, default: '' },
businessLogoId: { type: String, default: '' },

    // Add these fields
referralCode: { type: String, unique: true, sparse: true },
referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
upiId: { type: String, default: '' },

// Add this field
upiHistory: [{
    upiId: String,
    changedAt: { type: Date, default: Date.now }
}],
  
  // ============================================
  // 🔴 BUSINESS & GST FIELDS
  // ============================================
  gstNumber: { 
    type: String, trim: true, uppercase: true, default: '',
    validate: {
      validator: function(v) {
        if (!v) return true;
        return /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}[Z]{1}[0-9A-Z]{1}$/.test(v);
      },
      message: 'Invalid GST number format'
    }
  },
  businessName: { type: String, default: '' },
  businessAddress: { type: String, default: '' },
  
  // ============================================
  // 📝 LOGIN HISTORY
  // ============================================
  loginHistory: [{
    ip: { type: String, default: 'Unknown' },
    browser: { type: String, default: 'Unknown' },
    os: { type: String, default: 'Unknown' },
    device: { type: String, default: 'Desktop' },
    time: { type: Date, default: Date.now },
    success: { type: Boolean, default: true },
    failReason: { type: String, default: '' },
    isNewDevice: { type: Boolean, default: false }
  }],
  
  // ============================================
  // 🔐 2FA AUTHENTICATION FIELDS
  // ============================================
  twoFactorEnabled: { type: Boolean, default: false },
  twoFactorSecret: { type: String, default: null },
  twoFactorBackupCodes: [{ type: String }],
  twoFactorVerified: { type: Boolean, default: false },
  twoFactorSetupAt: { type: Date, default: null },
  
  // ============================================
  // 📊 SMART 2FA - DAILY LOGIN COUNTER
  // ============================================
  dailyLoginCount: { type: Number, default: 0 },
  dailyLoginDate: { type: String, default: '' },
  requireTwoFactorAfter: { type: Number, default: 3 }, // ✅ DEFAULT: 3 free logins, 4th pe 2FA
  
}, { timestamps: true });

// ============================================
// 🛡️ INDEXES
// ============================================
userSchema.index({ isAdmin: 1 });
userSchema.index({ isBanned: 1 });
userSchema.index({ bannedAt: -1 });
userSchema.index({ 'loginHistory.time': -1 });
userSchema.index({ email: 1, mobile: 1 });

// ============================================
// 🔧 HELPER METHODS
// ============================================

// 📝 Add login record
userSchema.methods.addLoginRecord = async function(loginData) {
  this.loginHistory.push({
    ip: loginData.ip || 'Unknown',
    browser: loginData.browser || 'Unknown',
    os: loginData.os || 'Unknown',
    device: loginData.device || 'Desktop',
    time: new Date(),
    success: loginData.success !== undefined ? loginData.success : true,
    failReason: loginData.failReason || '',
    isNewDevice: loginData.isNewDevice || false
  });
  
  // Keep only last 50 records
  if (this.loginHistory.length > 50) {
    this.loginHistory = this.loginHistory.slice(-50);
  }
  
  return this.save();
};

// 📊 Get recent successful logins
userSchema.methods.getRecentLogins = function(limit = 10) {
  return this.loginHistory
    .filter(login => login.success)
    .slice(-limit)
    .reverse();
};

// ❌ Get failed login attempts
userSchema.methods.getFailedLogins = function(limit = 10) {
  return this.loginHistory
    .filter(login => !login.success)
    .slice(-limit)
    .reverse();
};

// 🌐 Check if IP is known
userSchema.methods.isKnownIP = function(ip) {
  return this.loginHistory.some(
    login => login.ip === ip && login.success === true
  );
};

// 💻 Check if device is known
userSchema.methods.isKnownDevice = function(browser, os) {
  return this.loginHistory.some(
    login => login.browser === browser && 
             login.os === os && 
             login.success === true
  );
};

// 📊 Get login stats
userSchema.methods.getLoginStats = function() {
  const total = this.loginHistory.length;
  const successful = this.loginHistory.filter(l => l.success).length;
  const failed = total - successful;
  const newDevices = this.loginHistory.filter(l => l.isNewDevice).length;
  
  const uniqueIPs = [...new Set(this.loginHistory.map(l => l.ip))];
  const uniqueBrowsers = [...new Set(this.loginHistory.map(l => l.browser))];
  
  return {
    totalLogins: total,
    successfulLogins: successful,
    failedLogins: failed,
    newDevices: newDevices,
    uniqueIPs: uniqueIPs.length,
    uniqueBrowsers: uniqueBrowsers.length,
    lastLogin: this.loginHistory.length > 0 
      ? this.loginHistory[this.loginHistory.length - 1].time 
      : null
  };
};

// 🗑️ Clear login history
userSchema.methods.clearLoginHistory = function() {
  this.loginHistory = [];
  return this.save();
};

// ============================================
// 🔐 SMART 2FA METHODS
// ============================================

// 📊 Check if 2FA is required for this login
userSchema.methods.is2FARequired = function() {
  if (!this.twoFactorEnabled) {
    return { required: false, reason: '2FA not enabled' };
  }
  
  const today = new Date().toISOString().split('T')[0];
  
  // ✅ New day — counter reset
  if (this.dailyLoginDate !== today) {
    return { 
      required: false, 
      reason: 'New day — first login',
      loginsUsed: 0,
      maxFreeLogins: this.requireTwoFactorAfter || 3,
      remainingFree: this.requireTwoFactorAfter || 3
    };
  }
  
  const currentCount = this.dailyLoginCount || 0;
  const threshold = this.requireTwoFactorAfter || 3;
  
  // ✅ Within free limit
  if (currentCount < threshold) {
    return { 
      required: false, 
      reason: 'Within free limit',
      loginsUsed: currentCount,
      maxFreeLogins: threshold,
      remainingFree: threshold - currentCount
    };
  }
  
  // ❌ Limit reached — 2FA required
  return { 
    required: true, 
    reason: 'Daily free login limit reached',
    loginsUsed: currentCount,
    maxFreeLogins: threshold
  };
};

// 📊 Increment daily login counter
userSchema.methods.incrementDailyLogin = async function() {
  const today = new Date().toISOString().split('T')[0];
  
  if (this.dailyLoginDate !== today) {
    this.dailyLoginCount = 1;
    this.dailyLoginDate = today;
  } else {
    this.dailyLoginCount = (this.dailyLoginCount || 0) + 1;
  }
  
  return this.save();
};

// 🔄 Reset daily login counter
userSchema.methods.resetDailyLogin = async function() {
  this.dailyLoginCount = 0;
  this.dailyLoginDate = '';
  return this.save();
};

// 🔐 Reset lockout (ALL 2FA users)
userSchema.methods.resetLockout = async function() {
  this.loginAttempts = 0;
  this.lastFailedLogin = null;
  this.lockedUntil = null;
  return this.save();
};

// 🔒 Check if account is locked (ALL 2FA users)
userSchema.methods.isLocked = function() {
  if (!this.twoFactorEnabled) {
    return { locked: false };
  }
  
  if (this.lockedUntil && this.lockedUntil > new Date()) {
    const remainingMinutes = Math.ceil((this.lockedUntil - new Date()) / 60000);
    return {
      locked: true,
      remainingMinutes: remainingMinutes,
      lockedUntil: this.lockedUntil
    };
  }
  return { locked: false };
};

// 📊 Get daily 2FA status
userSchema.methods.getDaily2FAStatus = function() {
  const today = new Date().toISOString().split('T')[0];
  const dailyCount = this.dailyLoginDate === today ? (this.dailyLoginCount || 0) : 0;
  const freeLimit = this.requireTwoFactorAfter || 3;
  const remaining = Math.max(0, freeLimit - dailyCount);
  
  return {
    twoFactorEnabled: this.twoFactorEnabled,
    dailyLogins: dailyCount,
    freeLimit: freeLimit,
    remainingFree: remaining,
    nextRequires2FA: remaining <= 1,
    message: remaining > 1 
      ? `✅ ${remaining} free logins remaining today`
      : remaining === 1
      ? '⚠️ Last free login! Next will require 2FA'
      : '🔐 2FA required for all logins today'
  };
};

module.exports = mongoose.model('User', userSchema);
