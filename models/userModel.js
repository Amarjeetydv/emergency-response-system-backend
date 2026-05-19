const db = require("../config/db");

const findByEmail = async (email) => {
  const [rows] = await db.execute(
    "SELECT id, name, email, password, role, phone, approval_status, created_at FROM users WHERE email = ? LIMIT 1",
    [email]
  );
  return rows[0] || null;
};

const create = async ({ name, email, password, role, phone = null, approval_status = null }) => {
  const [result] = await db.execute(
    `INSERT INTO users (name, email, password, role, phone, approval_status)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, email, password, role, phone, approval_status]
  );
  return result.insertId;
};

const findById = async (id) => {
  const [rows] = await db.execute(
    "SELECT id, name, email, role, phone, approval_status, created_at FROM users WHERE id = ? LIMIT 1",
    [id]
  );
  return rows[0] || null;
};

const getAll = async () => {
  const [rows] = await db.execute(
    "SELECT id, name, email, role, phone, approval_status, created_at FROM users ORDER BY id DESC"
  );
  return rows;
};

const setApprovalStatus = async (id, status) => {
  await db.execute("UPDATE users SET approval_status = ? WHERE id = ?", [status, id]);
};

const updateRole = async (id, role) => {
  await db.execute("UPDATE users SET role = ? WHERE id = ?", [role, id]);
};

const deleteUser = async (id) => {
  await db.execute("DELETE FROM users WHERE id = ?", [id]);
};

const updatePasswordHash = async (id, passwordHash) => {
  await db.execute("UPDATE users SET password = ? WHERE id = ?", [passwordHash, id]);
};

module.exports = {
  findByEmail,
  create,
  findById,
  getAll,
  setApprovalStatus,
  updateRole,
  updatePasswordHash,
  delete: deleteUser,
};
