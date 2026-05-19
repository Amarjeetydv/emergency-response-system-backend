const Emergency = require('../models/emergencyModel');
const Log = require('../models/logModel');
const Message = require('../models/messageModel');

let OpenAI;
try {
  OpenAI = require('openai');
} catch (e) {
  console.warn('OpenAI module not found. AI classification features will be disabled.');
}

let ImageKit;
try {
  ImageKit = require('imagekit');
} catch (e) {
  console.warn('ImageKit module not found. Image uploads will be disabled.');
}

const ALLOWED_STATUSES = ['pending', 'accepted', 'in_progress', 'completed', 'cancelled', 'escalated'];

// Initialize OpenAI (ensure OPENAI_API_KEY is in your .env)
let openai = null;
if (OpenAI && process.env.OPENAI_API_KEY) {
  try {
    openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  } catch (error) {
    console.error('OpenAI initialization failed:', error.message);
  }
}

// Initialize ImageKit
let imagekit = null;
if (ImageKit && process.env.IMAGEKIT_PUBLIC_KEY && process.env.IMAGEKIT_PRIVATE_KEY && process.env.IMAGEKIT_URL_ENDPOINT) {
  imagekit = new ImageKit({
    publicKey: process.env.IMAGEKIT_PUBLIC_KEY,
    privateKey: process.env.IMAGEKIT_PRIVATE_KEY,
    urlEndpoint: process.env.IMAGEKIT_URL_ENDPOINT
  });
} else {
  console.warn('ImageKit credentials missing. File uploads will not be processed.');
}

// Helper: Haversine formula to calculate distance in Kilometers
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Radius of the earth in km
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function canActAsResponder(user) {
  if (!user) return false;
  if (['responder', 'dispatcher'].includes(user.role)) return true;
  if (['police', 'fire', 'ambulance'].includes(user.role)) {
    return user.approval_status === 'approved';
  }
  return false;
}

function canViewEmergencyFeed(user) {
  return user.role === 'admin' || canActAsResponder(user);
}

function validateTransition(current, next, { isAdmin, userId, row }) {
  if (isAdmin) return { ok: true };

  // Terminal states cannot be changed
  if (['completed', 'cancelled'].includes(current)) {
    return { ok: false, message: 'Emergency is already closed' };
  }

  // Flow: pending -> accepted
  if (current === 'pending' && next === 'accepted') return { ok: true };
  
  // Flow: pending -> escalated (System timeout)
  if (current === 'pending' && next === 'escalated') return { ok: true };
  if (current === 'escalated' && next === 'accepted') return { ok: true };

  // Flow: accepted -> in_progress
  if (current === 'accepted' && next === 'in_progress') {
    if (row.assigned_responder === userId) return { ok: true };
    return { ok: false, message: 'Only the assigned responder can move this to in progress' };
  }

  // Flow: in_progress -> completed
  if (current === 'in_progress' && next === 'completed') {
    if (row.assigned_responder === userId) return { ok: true };
    return { ok: false, message: 'Only the assigned responder can complete this' };
  }

  return { ok: false, message: `Invalid status transition from ${current} to ${next}` };
}

/**
 * Uses AI to classify the emergency based on user description
 */
async function classifyEmergencyText(text) {
  if (!openai) return null;

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: "You are an emergency dispatcher. Classify the user's input into exactly one of these categories: police, ambulance, fire, or other. Only output the category name in lowercase." },
        { role: "user", content: text }
      ],
      temperature: 0,
    });
    const category = response.choices[0].message.content.trim().toLowerCase();
    return ['police', 'ambulance', 'fire'].includes(category) ? category : 'other';
  } catch (error) {
    console.error('NLP Classification Error:', error);
    return null; // Return null so we can fallback to the manual type
  }
}

// @desc    Report a new emergency (citizen)
// @route   POST /api/emergencies
const createEmergency = async (req, res) => {
  // Debug logs to identify why fields are missing
  console.log('--- New Emergency Request ---');
  console.log('Content-Type:', req.headers['content-type']);
  console.log('Received Body:', req.body);

  const { emergency_type, emergencyType, description, latitude, longitude } = req.body || {};
  
  const finalEmergencyType = emergency_type || emergencyType;
  const parsedLat = (latitude !== undefined && latitude !== null) ? parseFloat(latitude) : NaN;
  const parsedLng = (longitude !== undefined && longitude !== null) ? parseFloat(longitude) : NaN;

  if (req.user.role !== 'citizen') {
    return res.status(403).json({ message: 'Only citizens can create emergency requests' });
  }

  if (!finalEmergencyType || isNaN(parsedLat) || isNaN(parsedLng)) {
    return res.status(400).json({ 
      message: 'Please provide emergency type, latitude, and longitude',
      received: { type: finalEmergencyType, lat: parsedLat, lng: parsedLng }
    });
  }

  try {
    let finalType = finalEmergencyType;

    // If description is provided, use AI to classify or verify the type
    if (description && description.length > 5) {
      const aiType = await classifyEmergencyText(description).catch(() => null);
      if (aiType) finalType = aiType;
    }

    let media_url = null;
    if (req.file && imagekit) {
      try {
        const uploadResponse = await imagekit.upload({
          file: req.file.buffer, // Buffer from memoryStorage
          fileName: `emergency-${Date.now()}-${req.file.originalname}`,
          folder: '/emergencies'
        });
        media_url = uploadResponse.url; // Use the absolute URL from ImageKit
      } catch (err) {
        console.error('ImageKit Upload Error:', err.message);
      }
    }

    const insertId = await Emergency.create(
      req.user.id,
      finalType,
      parsedLat,
      parsedLng,
      description || null,
      media_url
    );

    await Log.create(insertId, 'pending', req.user.id);
    console.log(`Emergency #${insertId} saved to DB.`);

    const io = req.app.get('socketio');
    const payload = await Emergency.findByIdDetailed(insertId);
    if (io) {
      io.emit('newEmergency', payload);
      console.log('Socket event "newEmergency" emitted');
    }

    res.status(201).json({ id: insertId, message: 'Emergency reported successfully', data: payload });
  } catch (error) {
    console.error('Create Emergency Error:', error);
    res.status(500).json({ message: 'Error reporting emergency', error: error.message });
  }
};

// @desc    List emergencies (citizen: own; admin / responders: all)
// @route   GET /api/emergencies
const getAllEmergencies = async (req, res) => {
  try {
    console.log(`Fetching emergencies for user: ${req.user.email} (Role: ${req.user.role})`);
    if (req.user.role === 'citizen') {
      const rows = await Emergency.findByCitizenId(req.user.id);
      return res.json(rows);
    }
    if (canViewEmergencyFeed(req.user)) {
      let rows = await Emergency.findAll();
      const { lat, lng } = req.query;

      // Nearest Responder Logic: Filter by distance (50km radius)
      if (lat && lng) {
        const rLat = parseFloat(lat);
        const rLng = parseFloat(lng);
        console.log(`Filtering for responder at: ${rLat}, ${rLng}`);
        rows = rows.filter(e => calculateDistance(rLat, rLng, e.latitude, e.longitude) <= 50);
      }

      return res.json(rows);
    }
    return res.status(403).json({ message: 'Forbidden' });
  } catch (error) {
    res.status(500).json({ message: 'Error fetching emergencies' });
  }
};

// @desc    Specific handler for accepting a request with location
// @route   POST /api/emergencies/accept-request
const acceptRequest = async (req, res) => {
  const { request_id, responder_lat, responder_lng } = req.body;
  const responder_id = req.user.id; // Correct: Use the ID from the authenticated token

  if (!request_id) {
    return res.status(400).json({ message: 'Missing required request id' });
  }

  try {
    // Atomic update: only update if status is still pending
    const affectedRows = await Emergency.claim(
      request_id, 
      responder_id, 
      responder_lat ?? null, 
      responder_lng ?? null
    );

    if (affectedRows === 0) {
      return res.status(409).json({ message: 'Request already taken by another responder' });
    }

    const updated = await Emergency.findByIdDetailed(request_id);

    const io = req.app.get('socketio');
    // Real-time: Notify everyone that the request is taken
    io.emit('requestAccepted', updated);
    io.emit('emergencyUpdate', updated);

    res.json(updated);
  } catch (error) {
    res.status(500).json({ message: error.message });
  }
};

// @desc    Get chat history for an emergency
// @route   GET /api/emergencies/:id/chat
const getChatHistory = async (req, res) => {
  try {
    const messages = await Message.findByEmergencyId(req.params.id);
    res.json(messages);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching chat history' });
  }
};

// @desc    Update emergency status
// @route   PUT /api/emergencies/:id
const updateStatus = async (req, res) => {
  const { status, responder_lat, responder_lng } = req.body;
  const emergencyId = Number(req.params.id);
  const responder_id = req.user.id; // Use secure ID from JWT

  if (!status || !ALLOWED_STATUSES.includes(status)) {
    return res.status(400).json({ message: 'Valid status is required' });
  }

  try {
    const existing = await Emergency.findById(emergencyId);
    if (!existing) {
      return res.status(404).json({ message: 'Emergency not found' });
    }

    const uid = req.user.id;
    const isAdmin = req.user.role === 'admin';
    const isOwnerCitizen = req.user.role === 'citizen' && existing.citizen_id === uid;
    const responderOk = canActAsResponder(req.user);

    if (isOwnerCitizen) {
      if (status !== 'cancelled') {
        return res.status(403).json({ message: 'You can only cancel your own request' });
      }
      if (!['pending', 'accepted', 'in_progress'].includes(existing.status)) {
        return res.status(400).json({ message: 'This emergency cannot be cancelled' });
      }
      await Emergency.update('cancelled', null, null, null, emergencyId);
      await Log.create(emergencyId, 'cancelled', uid);
      const io = req.app.get('socketio');
      const payload = await Emergency.findByIdDetailed(emergencyId);
      io.emit('emergencyUpdate', payload);
      return res.json({ message: 'Status updated' });
    }

    if (!isAdmin && !responderOk) {
      return res.status(403).json({ message: 'Forbidden' });
    }

    if (isAdmin && status === 'cancelled') {
      await Emergency.update('cancelled', existing.assigned_responder, null, null, emergencyId);
      await Log.create(emergencyId, 'cancelled', uid);
      const io = req.app.get('socketio');
      io.emit('emergencyUpdate', await Emergency.findByIdDetailed(emergencyId));
      return res.json({ message: 'Status updated' });
    }

    const check = validateTransition(existing.status, status, {
      isAdmin,
      userId: uid,
      row: existing
    });
    if (!check.ok) {
      return res.status(400).json({ message: check.message });
    }

    let assignId = existing.assigned_responder;
    if (status === 'accepted' && (existing.status === 'pending' || existing.status === 'escalated')) {
      assignId = responder_id != null ? Number(responder_id) : uid;
      
      // Atomic update: only update if status is still pending
      const affectedRows = await Emergency.claim(
        emergencyId,
        assignId,
        responder_lat,
        responder_lng
      );

      if (affectedRows === 0) {
        return res.status(409).json({ message: 'This request has already been accepted by another responder.' });
      }
    } else {
      // For other status transitions, use the standard update
      const cleanStatus = String(status).trim().toLowerCase().replace(/[^a-z_]/g, '');
      await Emergency.update(cleanStatus, assignId, responder_lat, responder_lng, emergencyId);
    }
    await Log.create(emergencyId, status, uid);

    const io = req.app.get('socketio');
    io.emit('emergencyUpdate', await Emergency.findByIdDetailed(emergencyId));

    res.json({ message: 'Status updated' });
  } catch (error) {
    console.error('updateEmergencyStatus', error);
    res.status(500).json({ message: 'Error updating status' });
  }
};

// @desc    Get admin logs
// @route   GET /api/emergencies/admin/logs
const getAdminLogs = async (req, res) => {
  try {
    const logs = await Emergency.findAll();
    res.json(logs);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching logs' });
  }
};

const processEscalations = async (io) => {
  try {
    const staleRequests = await Emergency.findStalePending(5); // 5 minute timeout
    
    for (const req of staleRequests) {
      // Use atomic escalation to prevent overwriting if a responder accepted it just now
      const affected = await Emergency.escalate(req.id);
      if (affected === 0) continue; 

      await Log.create(req.id, 'escalated', null); // null represents System/Automation
      
      const detailed = await Emergency.findByIdDetailed(req.id);
      
      // Notify dispatchers specifically or broadcast high-priority update
      io.emit('emergencyEscalated', detailed);
      io.emit('emergencyUpdate', detailed);

      console.log(`[Escalation] Emergency #${req.id} escalated due to timeout.`);
    }
  } catch (error) {
    console.error('Escalation logic error:', error);
  }
};

module.exports = { 
  createEmergency, 
  getAllEmergencies, 
  updateStatus, 
  acceptRequest, 
  getAdminLogs,
  processEscalations,
  getChatHistory
};
