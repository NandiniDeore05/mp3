var mongoose = require('mongoose');

var UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true},
    pendingTasks: { type: [String], default: [] },
    dateCreated: { type: Date, default: Date.now }
});

UserSchema.index({ email: 1 }, { unique: true });

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);
