const express = require('express');
const cors = require('cors');
const port = process.env.PORT || 5000
require('dotenv').config()

const app = express()
const jwt = require('jsonwebtoken')
const stripe = require('stripe')(process.env.PAYMENT_SECRET)
/* -------------------------------------------------------------------------- */
/*                                 MIDDLEWARE                                 */
/*  -------------------------------------------------------------------------- */
app.use(express.json())
app.use(cors())


const verifyJWT = (req, res, next) => {
  const authorization = req.headers.authorization
  if(!authorization){
    return res.status(401).send({error:true, message:"unauthorized token"})
  }
 
  const token = authorization.split(' ')[1]
   
  jwt.verify(token, process.env.ACCESS_TOKEN_SECRET,(err, decoded)=>{
    if(err){
      return res.status(401).send({error:true, message:"unauthorized token"})
    }
    req.decoded = decoded
    next()
  })
 }

/* -------------------------------------------------------------------------- */
/*                                   ROUTES                                   */
/* -------------------------------------------------------------------------- */
app.get('/', (req, res) => {
    res.send('Bistro boss server is running')
})


/* -------------------------------------------------------------------------- */
/*                              MONGODB CONNECTOR                             */
/* -------------------------------------------------------------------------- */

const { MongoClient, ServerApiVersion, ObjectId } = require("mongodb");
const uri = `mongodb+srv://${process.env.DB_USER}:${process.env.DB_PASS}@cluster0.yq2vgbi.mongodb.net/?retryWrites=true&w=majority`;

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

async function run() {
  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    const menuCollection = client.db("bistroDB").collection("menu");
    const reviewsCollection = client.db("bistroDB").collection("reviews");
    const cartCollection = client.db("bistroDB").collection("carts");
    const userCollection = client.db("bistroDB").collection("users");
    const paymentCollection = client.db("bistroDB").collection("payments");

    app.post('/jwt', (req, res) => {
      const user = req.body;

      const token = jwt.sign(user, process.env.ACCESS_TOKEN_SECRET, {
        expiresIn:"1h"
      })

      res.send({token});
    })

    const verifyAdmin = async(req, res, next) => {

      const email = req.decoded.email;
      const query = {email: email};
      const user = await userCollection.findOne(query);

      if(user?.role !=="admin"){
        return res.status(403).send({error:true, message:'Forbidden '})
      }
      next()
    }


    /* -------------------------------------------------------------------------- */
    /*                                 GET ROUTES                                 */
    /* -------------------------------------------------------------------------- */

    app.get('/total-products', async(reg, res) => {
      const result = await menuCollection.estimatedDocumentCount();
      res.send({totalProducts: result})
    })

    app.get('/users',verifyJWT, verifyAdmin, async(req, res) =>{
      const result = await userCollection.find().toArray()
      res.send(result)
    })


    app.get('/user/admin/:email',verifyJWT, async(req, res) =>{
      const email = req.params.email;
      if(req.decoded.email !== email){
        res.send({admin:false})
      }
      const query = {email: email};
      const user = await userCollection.findOne(query);
     const result = {admin: user?.role ==='admin'};

     res.send(result);
    })
    
    app.get("/menu", async (req, res) => {
      const result = await menuCollection.find().toArray();
      res.send(result);
    });



    app.get("/review", async (req, res) => {
      const result = await reviewsCollection.find().toArray();
      res.send(result);
    });

    app.get("/carts", verifyJWT, async (req, res) => {
      const email = req.query.email;

      if (!email) {
        res.send([]);
      }

      const decodedEmail = req.decoded.email
      if(email !== decodedEmail) {
        return res.status(403).send({error:true, message:"Forbidden access"})
      }


      const query = { email: email };
      const result = await cartCollection.find(query).toArray();
      res.send(result);
    });



    app.get('/admin-state',verifyJWT, verifyAdmin, async (req,res) => {
      const users =await userCollection.estimatedDocumentCount();
      const products =await menuCollection.estimatedDocumentCount();
      const orders =await paymentCollection.estimatedDocumentCount();

      const payments =await paymentCollection.find().toArray();
      const revenue =  payments.reduce((acc, cur) => acc += cur.price, 0)

      res.send({revenue, users, products, orders})
    })


    app.get('/order-stats', async(req,res) => {
      const pipeline =[
        {
          $lookup:{
            from:'menu',
            localField: 'menuItems',
            foreignField: '_id',
            as: 'menuItemsData'
          }
        },
        {
          $unwind:"$menuItemsData"
        },
        {
          $group:{
            _id: '$menuItemsData.category',
            count:{$sum: 1},
            totalPrice: { $sum: "$menuItemsData.price"}
          }
        }
      ]

      const result = await paymentCollection.aggregate(pipeline).toArray()

      res.send(result)
    })
    /* -------------------------------------------------------------------------- */
    /*                                    POST                                    */
    /* -------------------------------------------------------------------------- */

    app.post('/create-payment-intent', verifyJWT, async (req, res) => {
      const { price} = req.body;
      const amount = price * 100;

      const paymentIntent = await stripe.paymentIntents.create({
        amount:amount,
        currency:'usd',
        payment_method_types:['card']
      })

      res.send({clientSecret:paymentIntent.client_secret})
    })

    app.post('/payments', verifyJWT, async(req, res) => {
      const payment = req.body;
      const result = await paymentCollection.insertOne(payment)

      const query = {_id: {$in: payment.cartItemsId.map((id) => new ObjectId(id))}}

      const deleteResult = await cartCollection.deleteMany(query);

      res.send({result, deleteResult});
    })
    

    app.post('/menu',verifyJWT, verifyAdmin, async(req, res) => {
      const newItem = req.body;
      const result =await menuCollection.insertOne(newItem);

      res.send(result);
    })


    app.post("/carts", async (req, res) => {
      const item = req.body;
      const result = await cartCollection.insertOne(item);

      res.send(result);
    });

    app.post('/users', async (req, res) => {
      const user = req.body;
      const query = {email: user.email};
      const existingUser =await userCollection.findOne(query);

      if(existingUser){
        return res.send({message:'user already exists'})
      }
      const result = await userCollection.insertOne(user);

      res.send(result);
    })

    /* -------------------------------------------------------------------------- */
    /*                                    DELETE                                   */
    /* -------------------------------------------------------------------------- */
    app.delete("/cartdelete/:id", async (req, res) => {
      const id = req.params.id;
      const query = { _id: new ObjectId(id) };
      const result = await cartCollection.deleteOne(query);

      res.send(result);
    });


    app.delete('/menu/:id', verifyJWT, verifyAdmin, async(req,res) =>{
      const id = req.params.id;
      const query = { _id: new ObjectId(id)};
      const result = await menuCollection.deleteOne(query);

      res.send(result);
    })

    // Send a ping to confirm a successful connection
    await client.db("admin").command({ ping: 1 });
    console.log(
      "Pinged your deployment. You successfully connected to MongoDB!"
    );

    /* -------------------------------------------------------------------------- */
    /*                                   UPDATE                                   */
    /* -------------------------------------------------------------------------- */
    app.patch("/users/admin/:id", async (req, res) => {
      const id = req.params.id
      const filter = {_id: new ObjectId(id)}
      const updatedDoc={
        $set:{
          role:'admin'
        }
      } 

      const result = await userCollection.updateOne(filter,updatedDoc)

      res.send(result)
    })




  } finally {
    // Ensures that the client will close when you finish/error
    // await client.close();
  }
}
run().catch(console.dir);

/* -------------------------------------------------------------------------- */
/*                                  LISTENER                                  */
/* -------------------------------------------------------------------------- */

app.listen(port, ()=>{
    console.log(`Bistro boss is listening on port ${port}`);
})