var fs = require('fs')
  , tap = require('tap')
  , test = tap.test
  , request = require('request')

var api = require('../api')
  , couch = require('./couch')

couch.setup(test)

test('Builder API', function(t) {
  t.ok(couch.rtt(), 'The request duration should be known')

  var builder;

  t.doesNotThrow(function() { builder = new api.Builder }, 'Create a new builder')
  t.ok(builder, 'Got a builder object')

  function start() { builder.start() }

  var did = {}
  builder.on('template', function(template) { did.template = template })
  builder.on('output'  , function(output)   { did.output   = output   })
  builder.on('source'  , function(source)   { did.source   = source    })
  builder.on('start'   , function()         { did.start    = true     })

  builder.template = null
  t.throws(start, 'Throw for missing template')

  builder.template = 1;
  t.throws(start, 'Throw for bad template type')
  builder.template = function(doc) { return 'Doc!' }

  t.throws(start, 'Throw for missing output')
  builder.output = __dirname + '/output'

  t.throws(start, 'Throw for missing source db')

  builder.source = 'not_a_url'
  t.throws(start, 'Throw for bad Couch URL')

  builder.source = couch.DB
  t.doesNotThrow(start, 'No throw for all good starting data')

  // XXX: For now, don't worry about the notimplemented error.
  builder.on('error', function(er) {
    if(! er.message.match(/not implemented/))
      throw er
  })

  setTimeout(check_events, couch.rtt() * 1.5)

  function check_events() {
    t.ok(did.output, 'The output event finally fired')
    t.ok(did.template, 'The template event finally fired')
    t.ok(did.source, 'The source event finally fired')
    t.ok(did.start, 'The builder started')

    t.ok(builder.feed, 'The builder should have a feed by now')

    builder.stop()
    t.end()
  }
})

test('Autostart', function(t) {
  var builder = new api.Builder({ name:'Autostart', autostart:true })
  builder.source = couch.DB
  builder.output = {}
  builder.template = function() { return 'I autostarted!' }

  var events = { start:false, deploy:false }
  builder.on('start', function() { events.start = true })
  builder.on('deploy', function() { events.deploy = true })

  setTimeout(check_for_deploy, couch.rtt() * 2)
  function check_for_deploy() {
    t.ok(events.start, 'The builder should have started automatically')
    t.ok(events.deploy, 'The builder should have deployed by now')

    builder.stop()
    t.end()
  }
})
