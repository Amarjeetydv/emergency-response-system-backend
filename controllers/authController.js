const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const userModel = require("../models/userModel");
const User = userModel; // fix: User is used below

// Generate JWT
const generateToken = (user) => {
  return jwt.sign(
    { id: user.id, email: user.email, role: user.role },
    process.env.JWT_SECRET,
    { expiresIn: "30d" }
  );
};


// Add approval_status for responders
const registerUser = async (req, res) => {
  const { name, email, password, phone, role } = req.body;

  if (!name || !email || !password || !role) {
    return res.status(400).json({
      message: "Missing required fields",
      required: ["name", "email", "password", "role"],
    });
  }

  try {
    const existing = await User.findByEmail(email);
    if (existing) {
      return res.status(409).json({ message: "User already exists" });
    }

    // IMPORTANT: admin ko citizen me downgrade mat karo
    const userRole = role;

    const approval_status =
      ["police", "ambulance", "fire", "responder", "dispatcher"].includes(userRole)
        ? "pending"
        : null;

    const hashedPassword = await bcrypt.hash(password, 10);

    const userId = await User.create({
      name,
      email,
      password: hashedPassword,
      role: userRole,
      phone: phone || null,
      approval_status,
    });

    const createdUser = await User.findById(userId);

    return res.status(201).json({
      message: "User registered successfully",
      token: generateToken(createdUser),
      user: createdUser, // must include role
    });
  } catch (error) {
    console.error("registerUser error:", error);
    return res.status(500).json({ message: "Server error during registration" });
  }
};

const loginUser = async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findByEmail(email);

    if (!user) return res.status(401).json({ message: "Invalid email or password" });

    let ok = await bcrypt.compare(password, user.password);

    // Legacy compatibility: if old seed data stored plain-text password,
    // allow one-time login and immediately migrate to bcrypt hash.
    if (!ok && password === user.password) {
      ok = true;
      const hashedPassword = await bcrypt.hash(password, 10);
      await User.updatePasswordHash(user.id, hashedPassword);
    }

    if (!ok) return res.status(401).json({ message: "Invalid email or password" });

    return res.status(200).json({
      message: "Login successful",
      token: generateToken(user),
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        approval_status: user.approval_status
      }
    });
  } catch (err) {
    console.error("loginUser error:", err);
    return res.status(500).json({ message: "Server error during login" });
  }
};

// Get all users (for admin dashboard)
const getAllUsers = async (req, res) => {
  try {
    const users = await User.getAll();
    res.json(users);
  } catch (error) {
    res.status(500).json({ message: 'Failed to fetch users' });
  }
};

// Approve responder
const approveResponder = async (req, res) => {
  const { id } = req.params;
  try {
    await User.setApprovalStatus(id, 'approved');
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ message: 'Failed to approve responder' });
  }
};

const ALLOWED_ROLES = ['citizen', 'police', 'ambulance', 'fire', 'admin', 'responder', 'dispatcher'];

const updateUserRole = async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!role || !ALLOWED_ROLES.includes(role)) {
    return res.status(400).json({ message: 'Invalid role' });
  }

  try {
    await User.updateRole(id, role);
    if (['police', 'fire', 'ambulance'].includes(role)) {
      await User.setApprovalStatus(id, 'pending');
    } else {
      await User.setApprovalStatus(id, null);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('updateUserRole', error);
    res.status(500).json({ message: 'Failed to update role' });
  }
};

const deleteUser = async (req, res) => {
  const { id } = req.params;
  try {
    const user = await User.findById(id);
    if (!user) {
      return res.status(404).json({ message: 'User not found' });
    }

    // Prevent admins from deleting themselves via this endpoint if desired
    if (req.user.id === parseInt(id)) {
      return res.status(400).json({ message: 'Cannot delete your own admin account' });
    }

    await User.delete(id); 
    res.json({ success: true, message: 'User deleted successfully' });
  } catch (error) {
    console.error('deleteUser Error:', error); // Logs full error details to the server console
    res.status(500).json({ 
      message: 'Failed to delete user', 
      details: error.message,
      code: error.code 
    });
  }
};

module.exports = {
  registerUser,
  loginUser,
  getAllUsers,
  approveResponder,
  updateUserRole,
  deleteUser,
};
