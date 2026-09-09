const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const notificationService = require('../services/notification.service');
const { uploadMediaFile } = require('../services/cloudinary.service');

// @desc    Get all staff members / technicians
// @route   GET /api/v1/staff
// @access  Private (JWT Required)
const getStaff = async (req, res, next) => {
  try {
    const { search } = req.query;

    let sql = `
      SELECT 
        u.id as user_id,
        u.email,
        u.avatar_url,
        u.full_name as name,
        u.phone,
        u.role,
        u.is_active,
        sp.id as profile_id,
        sp.staff_code,
        sp.role_title,
        sp.color_hex,
        sp.working_days_json,
        sp.work_start_time,
        sp.work_end_time,
        sp.break_start_time,
        sp.break_end_time,
        sp.unavailable_dates_json,
        sp.kpi_score,
        sp.jobs_completed,
        sp.revisits,
        sp.home_address,
        sp.home_postcode,
        sp.duty_status,
        sp.created_at,
        sp.updated_at,
        COUNT(DISTINCT CASE WHEN w.pipeline_stage = 'Completed Jobs' THEN w.id END) as live_completed_jobs
      FROM users u
      LEFT JOIN staff_profiles sp ON u.id = sp.user_id
      LEFT JOIN work_orders w ON (w.assigned_staff_id = sp.id OR (w.assigned_staff_ids IS NOT NULL AND JSON_CONTAINS(w.assigned_staff_ids, CAST(sp.id AS JSON), '$')))
      WHERE u.role = 'MAINTENANCE_STAFF'
    `;

    const queryParams = [];

    if (search && search.trim() !== '') {
      const term = `%${search.trim()}%`;
      sql += ' AND (u.full_name LIKE ? OR u.email LIKE ? OR sp.staff_code LIKE ? OR sp.role_title LIKE ?)';
      queryParams.push(term, term, term, term);
    }

    sql += ' GROUP BY u.id, sp.id ORDER BY (live_completed_jobs * 100 + COALESCE(sp.kpi_score, 0)) DESC, sp.kpi_score DESC, u.created_at DESC';

    const [rows] = await pool.query(sql, queryParams);

    const formattedStaff = rows.map(r => {
      const actualCompleted = Math.max(r.live_completed_jobs || 0, r.jobs_completed || 0);
      const computedKpi = r.kpi_score > 0 ? r.kpi_score : (actualCompleted * 100);
      const computedRating = actualCompleted > 0 ? 4.9 : 0.0;
      const computedRevisitRate = actualCompleted > 0 ? Math.round(((r.revisits || 0) / actualCompleted) * 100) : 0;

      return {
        id: r.profile_id ? `stf-${r.profile_id}` : `usr-${r.user_id}`,
        profileId: r.profile_id,
        userId: r.user_id,
        staffCode: r.staff_code || `STF-${100 + r.user_id}`,
        name: r.name,
        email: r.email,
        avatarUrl: r.avatar_url || '',
        phone: r.phone || '',
        role: r.role_title || 'Maintenance Specialist',
        color: r.color_hex || '#009bf2',
        workingDays: r.working_days_json || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
        workingHours: {
          start: r.work_start_time ? String(r.work_start_time).substring(0, 5) : '08:00',
          end: r.work_end_time ? String(r.work_end_time).substring(0, 5) : '17:00',
        },
        breakTime: {
          start: r.break_start_time ? String(r.break_start_time).substring(0, 5) : '12:00',
          end: r.break_end_time ? String(r.break_end_time).substring(0, 5) : '13:00',
        },
        unavailable: r.unavailable_dates_json || [],
        kpiScore: computedKpi,
        jobsCompleted: actualCompleted,
        rating: computedRating,
        revisits: r.revisits || 0,
        revisitRate: computedRevisitRate,
        homeAddress: r.home_address || '',
        home_address: r.home_address || '',
        homePostcode: r.home_postcode || '',
        home_postcode: r.home_postcode || '',
        dutyStatus: r.duty_status || 'AVAILABLE',
      };
    });

    res.status(200).json({
      success: true,
      count: formattedStaff.length,
      data: formattedStaff,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Get single staff member by ID
// @route   GET /api/v1/staff/:id
// @access  Private (JWT Required)
const getStaffById = async (req, res, next) => {
  try {
    const { id } = req.params;
    const strId = String(id);

    let rows;
    if (strId.startsWith('stf-')) {
      const cleanId = strId.replace('stf-', '');
      [rows] = await pool.query(
        `SELECT 
          u.id as user_id, u.email, u.avatar_url, u.full_name as name, u.phone, u.role, u.is_active,
          sp.id as profile_id, sp.staff_code, sp.role_title, sp.color_hex,
          sp.working_days_json, sp.work_start_time, sp.work_end_time,
          sp.break_start_time, sp.break_end_time, sp.unavailable_dates_json,
          sp.kpi_score, sp.jobs_completed, sp.revisits,
          sp.home_address, sp.home_postcode, sp.duty_status
        FROM staff_profiles sp
        JOIN users u ON u.id = sp.user_id
        WHERE sp.id = ?`,
        [cleanId]
      );
    } else if (strId.startsWith('usr-')) {
      const cleanId = strId.replace('usr-', '');
      [rows] = await pool.query(
        `SELECT 
          u.id as user_id, u.email, u.avatar_url, u.full_name as name, u.phone, u.role, u.is_active,
          sp.id as profile_id, sp.staff_code, sp.role_title, sp.color_hex,
          sp.working_days_json, sp.work_start_time, sp.work_end_time,
          sp.break_start_time, sp.break_end_time, sp.unavailable_dates_json,
          sp.kpi_score, sp.jobs_completed, sp.revisits,
          sp.home_address, sp.home_postcode, sp.duty_status
        FROM users u
        LEFT JOIN staff_profiles sp ON u.id = sp.user_id
        WHERE u.id = ?`,
        [cleanId]
      );
    } else {
      [rows] = await pool.query(
        `SELECT 
          u.id as user_id, u.email, u.avatar_url, u.full_name as name, u.phone, u.role, u.is_active,
          sp.id as profile_id, sp.staff_code, sp.role_title, sp.color_hex,
          sp.working_days_json, sp.work_start_time, sp.work_end_time,
          sp.break_start_time, sp.break_end_time, sp.unavailable_dates_json,
          sp.kpi_score, sp.jobs_completed, sp.revisits,
          sp.home_address, sp.home_postcode, sp.duty_status
        FROM staff_profiles sp
        JOIN users u ON u.id = sp.user_id
        WHERE sp.id = ?`,
        [id]
      );
      if (rows.length === 0) {
        [rows] = await pool.query(
          `SELECT 
            u.id as user_id, u.email, u.avatar_url, u.full_name as name, u.phone, u.role, u.is_active,
            sp.id as profile_id, sp.staff_code, sp.role_title, sp.color_hex,
            sp.working_days_json, sp.work_start_time, sp.work_end_time,
            sp.break_start_time, sp.break_end_time, sp.unavailable_dates_json,
            sp.kpi_score, sp.jobs_completed, sp.revisits,
            sp.home_address, sp.home_postcode, sp.duty_status
          FROM users u
          LEFT JOIN staff_profiles sp ON u.id = sp.user_id
          WHERE u.id = ?`,
          [id]
        );
      }
    }

    if (!rows || rows.length === 0) {
      return res.status(404).json({
        success: false,
        message: `Staff profile not found with ID ${id}`,
      });
    }

    const r = rows[0];
    const staffObj = {
      id: r.profile_id ? `stf-${r.profile_id}` : `usr-${r.user_id}`,
      profileId: r.profile_id,
      userId: r.user_id,
      staffCode: r.staff_code || `STF-${100 + r.user_id}`,
      name: r.name,
      email: r.email,
      avatarUrl: r.avatar_url || '',
      phone: r.phone || '',
      role: r.role_title || 'Maintenance Specialist',
      color: r.color_hex || '#009bf2',
      workingDays: r.working_days_json || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'],
      workingHours: {
        start: r.work_start_time ? String(r.work_start_time).substring(0, 5) : '08:00',
        end: r.work_end_time ? String(r.work_end_time).substring(0, 5) : '17:00',
      },
      breakTime: {
        start: r.break_start_time ? String(r.break_start_time).substring(0, 5) : '12:00',
        end: r.break_end_time ? String(r.break_end_time).substring(0, 5) : '13:00',
      },
      unavailable: r.unavailable_dates_json || [],
      kpiScore: r.kpi_score || 0,
      jobsCompleted: r.jobs_completed || 0,
      revisits: r.revisits || 0,
      homeAddress: r.home_address || '',
      home_address: r.home_address || '',
      homePostcode: r.home_postcode || '',
      home_postcode: r.home_postcode || '',
      dutyStatus: r.dutyStatus || r.duty_status || 'AVAILABLE',
    };

    res.status(200).json({
      success: true,
      data: staffObj,
    });
  } catch (err) {
    next(err);
  }
};

// @desc    Create new staff / technician profile
// @route   POST /api/v1/staff
// @access  Private (Office Admin Only)
const createStaff = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const { full_name, name, email, phone, role, role_title, color, workingDays, startTime, endTime, password } = req.body;

    const staffName = (full_name || name || '').trim();
    const staffPhone = (phone || '').trim();
    const staffRoleTitle = (role_title || role || 'Maintenance Technician').trim();

    if (!staffName) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Staff Full Name is required.',
      });
    }

    if (!staffPhone) {
      await connection.rollback();
      connection.release();
      return res.status(400).json({
        success: false,
        message: 'Validation Error: Phone Number is required.',
      });
    }

    // Generate unique email if not provided
    const staffEmail = (email && email.trim() !== '') 
      ? email.trim().toLowerCase() 
      : `tech.${Date.now()}@nexusfms.com`;

    // Hash provided password or default for new technician account
    const salt = await bcrypt.genSalt(10);
    const plainPassword = (password && password.trim() !== '') ? password.trim() : 'Password123!';
    const passwordHash = await bcrypt.hash(plainPassword, salt);

    let avatarPath = req.body.avatarUrl || req.body.avatar_url || null;
    if (req.file) {
      const upRes = await uploadMediaFile(req.file, 'avatars');
      avatarPath = upRes?.url || `/uploads/${req.file.filename}`;
    }

    // 1. Create User
    const [userResult] = await connection.query(
      'INSERT INTO users (email, password_hash, full_name, role, phone, avatar_url, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [staffEmail, passwordHash, staffName, 'MAINTENANCE_STAFF', staffPhone, avatarPath, 1]
    );

    const userId = userResult.insertId;
    const staffCode = `STF-${100 + userId}`;
    const staffColor = color || '#009bf2';
    
    let daysArray = workingDays;
    if (typeof daysArray === 'string') {
      try {
        daysArray = JSON.parse(daysArray);
      } catch (e) {
        daysArray = daysArray.split(',').map(d => d.trim());
      }
    }
    const daysJson = JSON.stringify(daysArray || ['Mon', 'Tue', 'Wed', 'Thu', 'Fri']);

    // 2. Create Staff Profile
    const [profileResult] = await connection.query(
      `INSERT INTO staff_profiles 
        (user_id, staff_code, role_title, color_hex, working_days_json, work_start_time, work_end_time) 
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [userId, staffCode, staffRoleTitle, staffColor, daysJson, startTime || '08:00:00', endTime || '17:00:00']
    );

    const profileId = profileResult.insertId;

    await connection.commit();
    connection.release();

    // Create Notification
    try {
      const [adminRows] = await pool.query("SELECT id FROM users WHERE role = 'OFFICE_ADMIN'");
      for (const admin of adminRows) {
        await notificationService.createNotification({
          recipientUserId: admin.id,
          type: 'NEW_STAFF',
          title: 'New Staff Member Added',
          message: `Technician "${staffName}" has been added to the system.`,
          relatedEntityType: 'staff_profiles',
          relatedEntityId: profileId,
          actionUrl: '/admin/staff'
        });
      }
    } catch (notifErr) {
      console.error('[Notification] Failed to notify on staff creation:', notifErr);
    }

    res.status(201).json({
      success: true,
      message: 'Staff member created successfully.',
      data: {
        id: `stf-${profileId}`,
        profileId: profileId,
        userId: userId,
        staffCode: staffCode,
        name: staffName,
        email: staffEmail,
        phone: staffPhone,
        role: staffRoleTitle,
        color: staffColor,
      },
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

// @desc    Update staff profile
// @route   PUT /api/v1/staff/:id
// @access  Private (Office Admin Only)
const updateStaff = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const strId = String(id);
    const { full_name, name, phone, email, avatarUrl, avatar_url, role, role_title, color, workingDays, startTime, endTime, password, home_address, homeAddress, home_postcode, homePostcode, dutyStatus, duty_status } = req.body;

    let existing;
    if (strId.startsWith('stf-')) {
      const cleanId = strId.replace('stf-', '');
      [existing] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.id = ?',
        [cleanId]
      );
    } else if (strId.startsWith('usr-')) {
      const cleanId = strId.replace('usr-', '');
      [existing] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.user_id = ?',
        [cleanId]
      );
    } else {
      [existing] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.id = ?',
        [id]
      );
      if (existing.length === 0) {
        [existing] = await connection.query(
          'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.user_id = ?',
          [id]
        );
      }
    }

    if (!existing || existing.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Staff profile not found with ID ${id}`,
      });
    }

    // Authorization Check: User can update if they are an admin or if it is their own profile
    const isSelf = existing[0].user_id === req.user.id;
    const isAdmin = req.user.role === 'OFFICE_ADMIN';
    if (!isAdmin && !isSelf) {
      connection.release();
      return res.status(403).json({
        success: false,
        message: 'Forbidden. You are not authorized to update this profile.'
      });
    }

    const profileId = existing[0].profile_id;
    const userId = existing[0].user_id;
    const staffName = (full_name || name || '').trim();
    const staffPhone = (phone || '').trim();
    const staffEmail = (email || '').trim().toLowerCase();

    // Prevent duplicate email constraint crash if updated email belongs to someone else
    if (staffEmail) {
      const [emailCheck] = await connection.query(
        'SELECT id FROM users WHERE email = ? AND id != ?',
        [staffEmail, userId]
      );
      if (emailCheck.length > 0) {
        connection.release();
        return res.status(400).json({
          success: false,
          message: `The email '${staffEmail}' is already used by another account. Please choose a different email.`
        });
      }
    }

    await connection.beginTransaction();

    let staffAvatar = (avatarUrl !== undefined || avatar_url !== undefined) ? (avatarUrl || avatar_url || '') : null;
    if (req.file) {
      const upRes = await uploadMediaFile(req.file, 'avatars');
      staffAvatar = upRes?.url || `/uploads/${req.file.filename}`;
    }
    const staffRoleTitle = (role_title || role || 'Maintenance Technician').trim();

    if (staffName) {
      await connection.query(
        `UPDATE users SET 
          full_name = ?, 
          phone = ?, 
          email = COALESCE(NULLIF(?, ''), email),
          avatar_url = CASE WHEN ? IS NOT NULL THEN NULLIF(?, '') ELSE avatar_url END
         WHERE id = ?`,
        [staffName, staffPhone, staffEmail, staffAvatar, staffAvatar, userId]
      );
    }
    
    if (password && password.trim() !== '') {
      const salt = await bcrypt.genSalt(10);
      const hashedPassword = await bcrypt.hash(password.trim(), salt);
      await connection.query(
        'UPDATE users SET password_hash = ? WHERE id = ?',
        [hashedPassword, userId]
      );
    }

    let daysArray = workingDays;
    if (typeof daysArray === 'string') {
      try {
        daysArray = JSON.parse(daysArray);
      } catch (e) {
        daysArray = daysArray.split(',').map(d => d.trim());
      }
    }
    const daysJson = daysArray ? JSON.stringify(daysArray) : null;
    const staffHomeAddress = home_address || homeAddress || null;
    const staffHomePostcode = home_postcode || homePostcode || null;
    const staffDutyStatus = dutyStatus || duty_status || null;
    await connection.query(
      `UPDATE staff_profiles SET 
        role_title = COALESCE(?, role_title),
        color_hex = COALESCE(?, color_hex),
        working_days_json = COALESCE(?, working_days_json),
        work_start_time = COALESCE(?, work_start_time),
        work_end_time = COALESCE(?, work_end_time),
        home_address = CASE WHEN ? IS NOT NULL THEN ? ELSE home_address END,
        home_postcode = CASE WHEN ? IS NOT NULL THEN ? ELSE home_postcode END,
        duty_status = COALESCE(?, duty_status)
       WHERE id = ?`,
      [staffRoleTitle, color, daysJson, startTime, endTime, staffHomeAddress, staffHomeAddress, staffHomePostcode, staffHomePostcode, staffDutyStatus, profileId]
    );

    await connection.commit();
    connection.release();

    res.status(200).json({
      success: true,
      message: 'Staff profile updated successfully.',
    });
  } catch (err) {
    await connection.rollback();
    connection.release();
    next(err);
  }
};

// @desc    Delete staff profile & user account (Clean Cascade for Office Admin)
// @route   DELETE /api/v1/staff/:id
// @access  Private (Office Admin Only)
const deleteStaff = async (req, res, next) => {
  const connection = await pool.getConnection();
  try {
    const { id } = req.params;
    const strId = String(id);

    let rows;
    if (strId.startsWith('stf-')) {
      const cleanId = strId.replace('stf-', '');
      [rows] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.id = ?',
        [cleanId]
      );
    } else if (strId.startsWith('usr-')) {
      const cleanId = strId.replace('usr-', '');
      [rows] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.user_id = ?',
        [cleanId]
      );
    } else {
      [rows] = await connection.query(
        'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.id = ?',
        [id]
      );
      if (rows.length === 0) {
        [rows] = await connection.query(
          'SELECT sp.id as profile_id, sp.user_id FROM staff_profiles sp WHERE sp.user_id = ?',
          [id]
        );
      }
    }

    if (!rows || rows.length === 0) {
      connection.release();
      return res.status(404).json({
        success: false,
        message: `Staff profile not found with ID ${id}`,
      });
    }

    const profileId = rows[0].profile_id;
    const userId = rows[0].user_id;

    await connection.beginTransaction();

    // Disable foreign key checks for clean cascade
    await connection.query('SET FOREIGN_KEY_CHECKS = 0');

    // 1. Unassign staff from work orders
    await connection.query('UPDATE work_orders SET assigned_staff_id = NULL WHERE assigned_staff_id = ?', [profileId]);
    await connection.query('UPDATE work_orders SET created_by = NULL WHERE created_by = ?', [userId]);

    // Clean JSON assigned_staff_ids in work_orders if present
    try {
      const [allJobs] = await connection.query('SELECT id, assigned_staff_ids FROM work_orders WHERE assigned_staff_ids IS NOT NULL');
      for (const j of allJobs) {
        let ids = [];
        try {
          ids = typeof j.assigned_staff_ids === 'string' ? JSON.parse(j.assigned_staff_ids) : j.assigned_staff_ids;
        } catch (e) {}
        if (Array.isArray(ids) && (ids.includes(profileId) || ids.includes(Number(profileId)))) {
          const updatedIds = ids.filter(x => x !== profileId && x !== Number(profileId));
          await connection.query('UPDATE work_orders SET assigned_staff_ids = ? WHERE id = ?', [
            updatedIds.length > 0 ? JSON.stringify(updatedIds) : null,
            j.id
          ]);
        }
      }
    } catch (jsonErr) {
      console.warn('[deleteStaff] assigned_staff_ids cleanup skipped:', jsonErr.message);
    }

    // 2. Unassign from booking requests
    await connection.query('UPDATE booking_requests SET assignment_preference_staff_id = NULL WHERE assignment_preference_staff_id = ?', [profileId]);

    // 3. Remove associated job material costs
    try {
      await connection.query('DELETE FROM job_material_costs WHERE technician_id = ?', [profileId]);
    } catch (jmcErr) {
      console.warn('[deleteStaff] job_material_costs cleanup:', jmcErr.message);
    }

    // 4. Remove technician completion media & reports
    try {
      const [completions] = await connection.query('SELECT id FROM staff_job_completions WHERE staff_id = ?', [profileId]);
      if (completions.length > 0) {
        const cIds = completions.map(c => c.id);
        await connection.query('DELETE FROM staff_completion_media WHERE completion_id IN (?)', [cIds]);
        await connection.query('DELETE FROM staff_job_completions WHERE staff_id = ?', [profileId]);
      }
    } catch (compErr) {
      console.warn('[deleteStaff] completions cleanup:', compErr.message);
    }

    // 5. Remove notifications for this user
    try {
      await connection.query('DELETE FROM notifications WHERE user_id = ?', [userId]);
    } catch (notifErr) {}

    // 6. Delete staff profile and user account
    await connection.query('DELETE FROM staff_profiles WHERE id = ?', [profileId]);
    await connection.query('DELETE FROM users WHERE id = ?', [userId]);

    await connection.query('SET FOREIGN_KEY_CHECKS = 1');

    await connection.commit();
    connection.release();

    res.status(200).json({
      success: true,
      message: `Staff member ID ${id} and login account deleted successfully.`,
    });
  } catch (err) {
    try {
      await connection.query('SET FOREIGN_KEY_CHECKS = 1');
      await connection.rollback();
    } catch (rbErr) {}
    connection.release();
    next(err);
  }
};

module.exports = {
  getStaff,
  getStaffById,
  createStaff,
  updateStaff,
  deleteStaff,
};
