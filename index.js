import nedb from 'nedb'
import express from 'express'
import expressWs from 'express-ws'
import session from 'express-session'
import sessionDb from 'express-session-nedb'
import random from 'string-random'
import formidable from 'formidable'
import md5 from 'md5-node'
import HUB from './fmhub.js'
//import site from './collection.js'

const app = expressWs(express()).app
const databases = new Map() // 所有数据库
const FM = new HUB()        // 频道消息分发器

const db = (name) => (databases.get(name) || function () {
  let database = new nedb({ filename: `./data/db/${name}.db`, autoload: true, timestampData: true })
  databases.set(name, database)
  return database
}())

const session_store = sessionDb(session, db('session'))

// 登录验证
const online = function (req, res, next) {
  if (!req.session.account) return res.status(401).send('未登录')
  if (req.session.account.gid != 1) req.params.uid = req.session.account.uid
  next()
}

// 列表计量
const count_load = async (name, query) => await new Promise(resolve => db(name).count(query, (err, count) => resolve(count)))

// 条件查询
const list_load = async (name, query) => await new Promise(resolve => db(name).find(query, function (err, docs) {
  return resolve(docs.Map((item, index) => Object.assign({}, { _id: item.id })))
}))

const user_load = async (_id) => await new Promise(resolve => db('user').findOne({ _id }, function (err, doc) {
  if (!doc) return resolve(doc)
  let { salt, password, mobile, email, ...user } = doc
  return resolve(user)
}))

// 通讯频道 Frequency Modulation
function websocketer(ws, req) {
  // 游客使用公共账户 uid = 0
  let uid = req.session?.account?.uid || "0"
  console.log(`用户 ${uid} 连接了服务器`)

  // 访客默认订阅的频道列表: 一般是所有公开的频道
  let list = ["chat", "system"]
  list.forEach(fid => FM.订阅频道(fid, uid))

  // 当用户连接时, 读取其订阅列表
  if (req.session.account) {
    db('user').findOne({ uid }, function (err, doc) {
      if (doc && Array.isArray(doc.fm)) {
        doc.fm.forEach(fid => FM.订阅频道(fid, uid))
      }
    })
  }

  // 将连接加入到列表 ws
  FM.增加会话(uid, ws)

  // 收到消息时(只有频道消息)
  ws.on('message', function (msg) {
    if (typeof (msg) !== "string") return console.log("消息不是字符串")
    let { fm, data } = JSON.parse(msg)
    FM.发送消息(fm, uid, data)
  })

  // 关闭连接时
  ws.on('close', function (code) {
    FM.移除会话(uid, ws)
  })

  // 发生错误时
  ws.on('error', function (code) {
    console.log('link error: ', code)
  })
}

// 会话列表
function session_list(req, res) {
  return session_store.db.find({ "data.account.uid": req.session.account.uid }, function (err, docs) {
    return err ? res.status(500).send('错误') : res.json(docs)
  })
}

// 登录会话
function session_create(req, res) {
  return db('user').findOne({ name: req.body.name }, function (err, doc) {
    if (!doc) return res.status(400).send('账户不存在')
    if (md5(req.body.password + doc.salt) !== doc.password) return res.status(400).send('密码错误')
    return req.session.regenerate(function (err) {
      req.session.account = { uid: doc._id, gid: doc.gid ?? 0 }
      let { salt, password, ...user } = doc
      return res.json(user)
    })
  })
}

// 注销会话 (当前会话)
function sessionDeleteSelf(req, res) {
  return req.session.destroy(function (err) {
    return res.status(err ? 500 : 200).send(err ? '错误' : '退出登录')
  })
}

// 注销会话 (指定会话)
function session_delete(req, res) {
  return req.sessionStore.destroy(req.params.sid, function (err) {
    return err ? res.status(500).send('错误') : res.send('退出登录')
  })
}

// 账户资料 (当前账户)
function profile(req, res) {
  if (!req.session.account) return res.json({ name: '游客', avatar: '', online: false })
  return db('user').findOne({ _id: req.session.account.uid }, function (err, doc) {
    if (err) return res.status(400).send('账户不存在')
    doc.online = true
    delete doc.salt
    delete doc.password
    return res.json(doc)
  })
}

// 列表对象
const object_list = async function (req, res) {
  let { pagesize, page, count, like, post, tid, top, uid, user, sort, desc, ...query } = req.query

  if (tid) query.tid = Number(tid)      // 某些查询参数需要转换类型
  if (top) query.top = Number(top)      // 某些查询参数需要转换类型
  if (uid && uid !== req.session?.account?.uid) query.public = true // 如果查询条件限定为自己的, 则不用限制范围到公开的

  page = Number(page) || 1              // 默认页码1
  pagesize = Number(pagesize) || 20     // 默认分页20
  let skip = (page - 1) * pagesize      // 截取点

  // 登录状态时, 查询自己点赞过的和评论过的
  if (req.session?.account?.uid) {
    if (like) query.$or = await list_load('like', { attach: req.params.name, uid: req.session.account.uid })
    if (post) query.$or = await list_load('post', { attach: req.params.name, uid: req.session.account.uid })
  }

  // 消息限定范围
  if (req.params.name === 'message' && req.session.account.gid !== 1) {
    if (query.to) query.to = req.session.account.uid  // 只能查发给自己的消息
    else query.uid = req.session.account.uid          // 否则默认自己发出去的
  }

  // 要求附带统计信息
  if (count) await new Promise(resolve => db(req.params.name).count(query, function (err, count) {
    res.header('count', count)
    res.header('page', page)
    res.header('pages', Math.ceil(count / pagesize))
    res.header('pagesize', pagesize)
    resolve()
  }))

  desc = (desc === "1") ? 1 : -1
  let is_sort = {}
  switch (sort) {
    case 'top': is_sort.top = desc; break;
    case 'hot': is_sort.hot = desc; break;
    case 'createdAt': is_sort.createdAt = desc; break;
    case 'updatedAt': is_sort.updatedAt = desc; break;
    default:
  }

  return db(req.params.name).find(query).skip(skip).limit(pagesize).sort(sort).exec(async function (err, docs) {
    return res.json(await Promise.all(docs.map(async item => {
      item.posts = await count_load('post', { attach: req.params.name, aid: item._id }) // 附加评论数量
      item.likes = await count_load('like', { attach: req.params.name, aid: item._id }) // 附加点赞数量
      if (req.params.name === 'user') {
        delete item.salt
        delete item.password
        delete item.mobile
        delete item.email
      } else {
        item.user = await user_load(item.uid) // 附加用户信息(user对象没有作者)
      }
      return item
    })))
  })
}

// 创建对象
const object_create = async function (req, res) {

  if (req.session?.account?.gid != 1) {
    delete req.body._id       // 游客和普通用户禁止设置, 权限
    delete req.body.uid       // 游客和普通用户禁止设置, 权限
    delete req.body.top       // 游客和普通用户禁止设置, 权限
    delete req.body.user      // 游客和普通用户禁止设置, 计算
    delete req.body.createdAt // 游客和普通用户禁止设置, 自动
    delete req.body.updatedAt // 游客和普通用户禁止设置, 自动
    delete req.body.views     // 游客和普通用户禁止设置, 统计
    delete req.body.posts     // 游客和普通用户禁止设置, 统计
    delete req.body.likes     // 游客和普通用户禁止设置, 统计
    delete req.body.files     // 游客和普通用户禁止设置, 统计
  }

  // 如果创建对象是用户作一些特殊处理
  if (req.params.name === 'user') {
    if (!req.body.name) {
      return res.status(400).send('用户名不能为空')
    }
    if (!req.body.password) {
      return res.status(400).send('密码不能为空')
    }
    if (await count_load({ name: req.body.name })) {
      return res.status(400).send('用户名已被占用')
    }
    req.body.name = req.body.name || random(12)                // 默认用户名(检查用户名是否可用)
    req.body.avatar = req.body.avatar || ''                    // 默认用户头像
    req.body.gid = (await count_load('user', {})) ? 0 : 1      // 默认是管理员为首个注册用户
    req.body.salt = random(32)                                 // 密码加盐
    req.body.password = md5(req.body.password + req.body.salt) // 必要设置密码
    req.body.public = true                                     // 默认公开
  } else {
    if (!req.session.account) return res.status(401).send('需要登录')
    req.body.uid = req.session.account.uid                     // 为发表对象附上作者ID
    req.body.public = true                                     // 默认公开
    req.body.views = 0                                         // 再生计数
  }

  // 如果是挂载对象到指定目标
  if (req.body.attach && req.body.aid) {
    let count = await count_load(req.body.attach, { _id: req.body.aid })
    if (!count) return res.status(404).send('目标挂载对象不存在')
  }

  // 写入对象
  return db(req.params.name).insert(req.body, async function (err, doc) {
    if (!doc) return res.status(500).send('创建失败')
    if (req.params.name !== 'user') {
      doc.user = await user_load(doc.uid)
    } else {
      delete doc.salt
      delete doc.password
    }
    return res.json(doc)
  })
}

// 删除对象
const object_remove = function (req, res) {
  return db(req.params.name).findOne({ _id: req.params._id }, async function (err, doc) {
    if (!doc) return res.status(404).send('目标对象不存在')

    // 如果是删除用户作一些特殊处理
    if (req.params.name === 'user') {
      if (req.session.account.gid !== 1 && req.session.account.uid !== doc._id) {
        return res.status(400).send('没有权限删除此账户')
      }
      if (await count_load('account', { _id: req.params.id, gid: 1 }) === 1) {
        return res.status(400).send('不可以删除唯一的管理员账户')
      }
    } else {
      if (req.session.account.gid !== 1 && req.session.account.uid !== doc.uid) {
        return res.status(403).send('没有权限删除此对象')
      }
    }

    // TODO: 处理掉一些附属对象

    return db(req.params.name).remove({ _id: req.params._id }, function (err, count) {
      return count ? res.send('删除成功') : res.status(403).send('删除失败')
      // TODO: 当对象被删除时通过此连接通知所有在线终端
    })
  })
}

// 读取对象
const object_load = function (req, res) {
  return db(req.params.name).findOne({ _id: req.params._id }, async function (err, doc) {
    if (!doc) {
      return res.status(404).send('目标资源不存在')
    }
    if (!doc.public && doc.uid !== session?.account?.uid) {
      return res.status(403).send('没有权限读取')
    }
    if (req.params.name === 'user') {
      delete doc.salt
      delete doc.password
      delete doc.mobile
      delete doc.email
    } else {
      doc.user = await user_load(doc.uid)
    }
    db(req.params.name).update({ _id: req.params._id }, { $set: { views: doc.views ? doc.views + 1 : 1 } })
    return res.json(doc)
    //return res.json({ user: await user_load(doc.uid), ...doc })
  })
}

// 修改对象
const object_patch = function (req, res) {
  return db(req.params.name).findOne({ _id: req.params._id }, function (err, doc) {
    if (!doc) return res.status(404).send('目标对象不存在')
    // 如果是 user 做一些特殊处理
    if (req.params.name === 'user') {
      if (req.session.account.uid !== doc._id && req.session.account.gid !== 1) {
        return res.status(403).send('没有权限修改账户')
      }
      if (req.body.gid && req.session.account.gid !== 1) {
        return res.status(403).send('没有权限修改权限')
      }
      if (req.body.password) {
        req.body.salt = random(32)                                 // 密码加盐
        req.body.password = md5(req.body.password + req.body.salt) // 设置密码
      }
      if (req.body.name) {
        // 检查用户名是否可用
      }
    } else {
      if (req.session.account.uid !== doc.uid && req.session.account.gid !== 1) {
        return res.status(403).send('没有权限修改对象')
      }
      if (req.body.uid && req.session.account.gid !== 1) {
        return res.status(403).send('没有权限修改归属')
      }
    }
    return db(req.params.name).update({ _id: req.params._id }, { $set: req.body }, function (err, count) {
      if (!count) return res.status(500).send('修改失败')
      return res.send('修改成功')
    })
  })
}

// 附件上传
const file_upload = function (req, res) {
  return db(req.params.name).findOne({ _id: req.params._id }, function (err, doc) {
    if (!doc) return res.status(404).send('目标对象不存在')
    if (req.session.account.uid !== doc.uid && req.session.account.gid !== 1) {
      return res.status(403).send('没有权限上传')
    }
    return formidable({ multiples: true, uploadDir: 'data/file', keepExtensions: true, maxFieldsSize: 200 * 1024 * 1024 }).parse(req, function (err, fields, files) {
      let list = []
      for (let key in files) {
        (Array.isArray(files[key]) ? files[key] : [files[key]]).map(({ filepath, mimetype, mtime, newFilename, originalFilename, size }) => list.push({
          filepath, mimetype, mtime, newFilename, originalFilename, size
        }))
      }
      return db(req.params.name).update({ _id: req.params._id }, { $addToSet: { file: { $each: list } } }, function (err, count) {
        if (!count) return res.status(500).send('附件挂载对象失败')
        console.log(list)
        return res.json(list)
      })
    })
  })
}

const db_compact = function (req, res) {
  db(req.params.name).persistence.compactDatafile()
  return res.send("ok")
}

app.use(express.json())
app.use(express.urlencoded({ extended: false }))
app.use(session({ secret: 'kana', name: 'sid', resave: false, saveUninitialized: false, cookie: { maxAge: 180 * 24 * 3600000 }, store: session_store }))
app.use('/data/file/', express.static('data/file'))
app.ws('/', websocketer)
app.route('/').get((req, res) => res.send(`<DOCTYPE html><p> Hello World</p>`))
app.route('/account').get(profile)
app.route('/session').get(online, session_list).post(session_create).delete(online, sessionDeleteSelf)
app.route('/session/:sid').delete(online, session_delete)
app.route('/:name').get(object_list).post(object_create).put(db_compact)
app.route('/:name/:_id').get(object_load).post(online, file_upload).put().patch(online, object_patch).delete(online, object_remove)
app.listen(2333)
