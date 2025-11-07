var express = require('express');
var router = express.Router();
var Task = require('../models/task');
var User = require('../models/user');

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

function sendResponse(res, status, message, data) {
  return res.status(status).json({ message, data });
}

router
  .route('/tasks')
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

      const q = Task.find(where || {});
      if (select) q.select(select);
      if (sort) q.sort(sort);
      if (!isNaN(skip)) q.skip(skip);
      if (!isNaN(limit)) q.limit(limit);

      if (count) {
        const cnt = await Task.countDocuments(where || {});
        return sendResponse(res, 200, 'OK', cnt);
      }

      const tasks = await q.exec();
      return sendResponse(res, 200, 'OK', tasks);
    })
  )

  .post(
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.name || !body.deadline)
        return sendResponse(res, 400, 'Task must have a name and a deadline', {});

      let assignedUserDoc = null;
      if (body.assignedUser) {
        assignedUserDoc = await User.findById(body.assignedUser).exec();
        if (!assignedUserDoc)
          return sendResponse(res, 404, 'Assigned user not found', { missing: [body.assignedUser] });

        if (
          body.hasOwnProperty('assignedUserName') &&
          String(body.assignedUserName) !== String(assignedUserDoc.name)
        ) {
          return sendResponse(res, 400, 'assignedUserName does not match user record', {});
        }

        body.assignedUserName = assignedUserDoc.name;
      }

      const newTask = new Task({
        name: body.name,
        description: body.description || '',
        deadline: body.deadline,
        completed: body.completed === 'true' || body.completed === true,
        assignedUser: body.assignedUser || '',
        assignedUserName: body.assignedUserName || 'unassigned',
      });

      try {
        const task = await newTask.save();
        if (task.assignedUser && !task.completed) {
          await User.updateOne(
            { _id: task.assignedUser },
            { $addToSet: { pendingTasks: task._id.toString() } }
          );
          await normalizePendingTasksForUser(task.assignedUser);
        }
        return sendResponse(res, 201, 'Task created', task);
      } catch (err) {
        return sendResponse(res, 500, 'Error creating task', err);
      }
    })
  );

router
  .route('/tasks/:id')
  .get(
    asyncHandler(async (req, res) => {
      const select = parseJSONParam(req.query.select);
      if (select?.__parseError)
        return sendResponse(res, 400, 'Invalid JSON in select parameter', {});
      const q = select ? Task.findById(req.params.id).select(select) : Task.findById(req.params.id);
      const task = await q.exec();
      if (!task) return sendResponse(res, 404, 'Task not found', {});
      return sendResponse(res, 200, 'OK', task);
    })
  )

  .put(
    asyncHandler(async (req, res) => {
      const body = req.body || {};
      if (!body.name || !body.deadline)
        return sendResponse(res, 400, 'Task must have a name and a deadline', {});

      const task = await Task.findById(req.params.id).exec();
      if (!task) return sendResponse(res, 404, 'Task not found', {});
      if (task.completed)
        return sendResponse(res, 400, 'Cannot modify a completed task', {});

      const prevAssigned = task.assignedUser || '';

      task.name = body.name;
      task.description = body.description || '';
      task.deadline = body.deadline;
      task.completed = body.completed === 'true' || body.completed === true;

      if (body.assignedUser) {
        const assignedUserDoc = await User.findById(body.assignedUser).exec();
        if (!assignedUserDoc)
          return sendResponse(res, 404, 'Assigned user not found', { missing: [body.assignedUser] });

        if (
          body.hasOwnProperty('assignedUserName') && body.assignedUserName.toLowerCase() !== 'unassigned' &&
          String(body.assignedUserName) !== String(assignedUserDoc.name)
        ) {
          return sendResponse(res, 400, 'assignedUserName does not match user record', {});
        }

        task.assignedUser = body.assignedUser;
        task.assignedUserName = assignedUserDoc.name;
      } else {
        task.assignedUser = '';
        task.assignedUserName = 'unassigned';
      }

      await task.save();

      const cur = task.assignedUser || '';

      if (prevAssigned && prevAssigned !== cur) {
        await User.updateOne(
          { _id: prevAssigned },
          { $pull: { pendingTasks: task._id.toString() } }
        );
        await normalizePendingTasksForUser(prevAssigned);
      }

      if (task.assignedUser) {
        if (task.completed) {
          await User.updateOne(
            { _id: task.assignedUser },
            { $pull: { pendingTasks: task._id.toString() } }
          );
        } else {
          await User.updateOne(
            { _id: task.assignedUser },
            { $addToSet: { pendingTasks: task._id.toString() } }
          );
        }
        await normalizePendingTasksForUser(task.assignedUser);
      }

      return sendResponse(res, 200, 'Task updated', task);
    })
  )

  .delete(
    asyncHandler(async (req, res) => {
      const task = await Task.findById(req.params.id).exec();
      if (!task) return sendResponse(res, 404, 'Task not found', {});

      if (task.assignedUser) {
        await User.updateOne(
          { _id: task.assignedUser },
          { $pull: { pendingTasks: task._id.toString() } }
        );
        await normalizePendingTasksForUser(task.assignedUser);
      }

      await Task.deleteOne({ _id: req.params.id });
      return res.status(204).end();
    })
  );

module.exports = router;
