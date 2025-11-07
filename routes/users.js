var express = require('express');
var router = express.Router();
var User = require('../models/user');
var Task = require('../models/task');

const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

async function normalizePendingTasksForUser(userId) {
  const u = await User.findById(userId).exec();
  if (!u) return;
  const normalized = Array.from(new Set((u.pendingTasks || []).map(String)));
  const same =
    normalized.length === (u.pendingTasks || []).length &&
    normalized.every((v, i) => v === String((u.pendingTasks || [])[i]));
  if (!same) {
    await User.updateOne({ _id: userId }, { $set: { pendingTasks: normalized } }).exec();
  }
}

function parseJSONParam(param) {
  if (!param) return undefined;
  try {
    return JSON.parse(param);
  } catch (e) {
    return { __parseError: true };
  }
}

function emailContainsAt(e) {
  return typeof e === 'string' && e.includes('@');
}

function sendResponse(res, status, message, data) {
  return res.status(status).json({ message, data });
}

router
  .route('/users')
  .get(
    asyncHandler(async (req, res) => {
      const where = parseJSONParam(req.query.where);
      if (where?.__parseError)
        return sendResponse(res, 400, 'Invalid JSON in where parameter', {});
      const sort = parseJSONParam(req.query.sort);
      if (sort?.__parseError)
        return sendResponse(res, 400, 'Invalid JSON in sort parameter', {});
      const select = parseJSONParam(req.query.select);
      if (select?.__parseError)
        return sendResponse(res, 400, 'Invalid JSON in select parameter', {});

      const skip = req.query.skip ? parseInt(req.query.skip) : undefined;
      const limit = req.query.limit ? parseInt(req.query.limit) : undefined;
      const count = req.query.count === 'true' || req.query.count === true;

      const q = User.find(where || {});
      if (select) q.select(select);
      if (sort) q.sort(sort);
      if (!isNaN(skip)) q.skip(skip);
      if (!isNaN(limit)) q.limit(limit);

      if (count) {
        const cnt = await User.countDocuments(where || {});
        return sendResponse(res, 200, 'OK', cnt);
      }

      const users = await q.exec();
      return sendResponse(res, 200, 'OK', users);
    })
  )

  .post(
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.name || !body.email)
        return sendResponse(res, 400, 'User must have a name and an email', {});
      if (!emailContainsAt(body.email))
        return sendResponse(res, 400, 'Invalid email format', {});
      if (body.pendingTasks && body.pendingTasks.length)
        return sendResponse(res, 400, 'Cannot set pendingTasks when creating a new user', {});

      const newUser = new User({ name: body.name, email: body.email, pendingTasks: [] });

      try {
        const user = await newUser.save();
        await normalizePendingTasksForUser(user._id);
        const fresh = await User.findById(user._id).exec();
        return sendResponse(res, 201, 'User created', fresh);
      } catch (err) {
        if (err.code === 11000)
          return sendResponse(res, 400, 'A user with that email already exists', {});
        return sendResponse(res, 500, 'Error creating user', err);
      }
    })
  );

router
  .route('/users/:id')
  .get(
    asyncHandler(async (req, res) => {
      const select = parseJSONParam(req.query.select);
      if (select?.__parseError)
        return sendResponse(res, 400, 'Invalid JSON in select parameter', {});
      const q = select ? User.findById(req.params.id).select(select) : User.findById(req.params.id);
      const user = await q.exec();
      if (!user) return sendResponse(res, 404, 'User not found', {});
      return sendResponse(res, 200, 'OK', user);
    })
  )

  .put(
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.name || !body.email)
        return sendResponse(res, 400, 'User must have a name and an email', {});
      if (!emailContainsAt(body.email))
        return sendResponse(res, 400, 'Invalid email format', {});

      try {
        const user = await User.findById(req.params.id).exec();
        if (!user) return sendResponse(res, 404, 'User not found', {});

        const prevPending = (user.pendingTasks || []).map(String);

        user.name = body.name;
        user.email = body.email;
        user.pendingTasks = Array.isArray(body.pendingTasks)
          ? Array.from(new Set(body.pendingTasks.map(String)))
          : [];

        if (user.pendingTasks.length > 0) {
          const tasks = await Task.find({ _id: { $in: user.pendingTasks } }).select('_id completed').exec();

          const foundIds = tasks.map(t => String(t._id));
          const missing = user.pendingTasks.filter(tid => !foundIds.includes(String(tid)));
          if (missing.length)
            return sendResponse(res, 404, 'One or more tasks not found', { missing });

          const hasCompleted = tasks.some(t => t.completed);
          if (hasCompleted)
            return sendResponse(res, 400, 'Cannot assign completed tasks as pending', {});
        }

        await user.save();

        if (user.pendingTasks.length) {
          const tasks = await Task.find({ _id: { $in: user.pendingTasks } }).exec();
          const incomplete = tasks.filter((t) => !t.completed).map((t) => String(t._id));

          for (const t of tasks) {
            const prev = t.assignedUser ? String(t.assignedUser) : '';
            if (t.completed || !prev || prev === String(user._id)) continue;
            await User.updateOne({ _id: prev }, { $pull: { pendingTasks: t._id.toString() } });
            await normalizePendingTasksForUser(prev);
          }

          if (incomplete.length) {
            await Task.updateMany(
              { _id: { $in: incomplete } },
              { $set: { assignedUser: user._id.toString(), assignedUserName: user.name } }
            );
            await User.updateOne({ _id: user._id }, { $set: { pendingTasks: incomplete } });
          } else {
            await User.updateOne({ _id: user._id }, { $set: { pendingTasks: [] } });
          }
        }

        const removed = (prevPending || []).filter((t) => !user.pendingTasks.includes(t));
        if (removed.length) {
          await Task.updateMany(
            { _id: { $in: removed }, completed: false },
            { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
          );
        }

        await Task.updateMany(
          { assignedUser: user._id.toString() },
          { $set: { assignedUserName: user.name } }
        );

        await normalizePendingTasksForUser(user._id);
        const fresh = await User.findById(user._id).exec();
        return sendResponse(res, 200, 'User updated', fresh);
      } catch (err) {
        if (err.code === 11000)
          return sendResponse(res, 400, 'A user with that email already exists', {});
        return sendResponse(res, 500, 'Error updating user', err);
      }
    })
  )

  .delete(
    asyncHandler(async (req, res) => {
      const user = await User.findById(req.params.id).exec();
      if (!user) return sendResponse(res, 404, 'User not found', {});
      if (user.pendingTasks?.length) {
        await Task.updateMany(
          { _id: { $in: user.pendingTasks } },
          { $set: { assignedUser: '', assignedUserName: 'unassigned' } }
        );
      }
      await User.deleteOne({ _id: req.params.id });
      return res.status(204).end();
    })
  );

module.exports = router;
